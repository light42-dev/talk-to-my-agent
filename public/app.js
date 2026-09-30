// The demo page: you play the recruiter, the agent answers Maya's number.
// Audio capture and playback are adapted from AssemblyAI's official starter
// (github.com/AssemblyAI/voice-agent-starter-js). Everything the agent does
// with tools runs in ./core, which the server and the tests share.

import { createCallSession } from './core/call.js'
import { APPLICATIONS, CANDIDATE } from './core/candidate.js'
import { describePay, formatDate, overallFit } from './core/facts.js'
import { decisionText, finalizeCall, noteDelivery, workText } from './core/report.js'
import { SCAM_REASONS, scamVerdict } from './core/scam.js'
import { buildSession } from './core/session.js'
import { createCallState, serializeState } from './core/tools.js'

const $ = (id) => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) if (child !== null && child !== undefined) node.append(child)
  return node
}

const WIRE_RATE = 24_000
// The agent's audio arrives in real time, in 10 ms pieces. Playback waits for a
// small cushion so a network hiccup doesn't leave the speaker with a gap.
const PLAYBACK_CUSHION_MS = 200
const PLAYBACK_MAX_WAIT_MS = 300
// Microphone audio goes out in 20 ms frames instead of one message per 5 ms.
const CAPTURE_FRAME_SAMPLES = 480
const params = new URLSearchParams(location.search)
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
// Tests point the page at a fake server; nothing else can.
const WS_URL = (isLocal && params.get('aai_ws')) || 'wss://agents.assemblyai.com/v1/ws'
const FIRST = CANDIDATE.firstName

// ---- static content ------------------------------------------------------

const SCENARIOS = [
  {
    title: 'A real recruiter',
    blurb: 'Northwind Analytics, the role Maya applied for',
    lines: "Hi, this is Jen Park from Northwind Analytics, about the Senior Data Analyst role. The range is one fifteen to one thirty-five base. Hybrid, two days a week in Austin. Four rounds, and we'll decide by October twentieth. My email is jen dot park at northwind dash analytics dot com.",
  },
  {
    title: 'A recruiter who hides the pay',
    blurb: 'Only shares a pay range when pushed',
    lines: "Hi, I'm Sam from Keystone Freight about the BI role. We don't really share ranges this early. What is she looking for? ...Fine, ballpark one ten to one twenty-five.",
  },
  {
    title: 'A low offer from an agency',
    blurb: 'A contract below her minimum rate, on-site in another city',
    lines: "Hey, Mike from TalentBridge Staffing. I've got a twelve-month W-2 contract, forty dollars an hour, on-site in Dallas five days a week.",
  },
  {
    title: 'A job scammer',
    blurb: 'Asks for a fee and a Telegram interview',
    lines: "Congratulations, Maya's been selected! To start, there's just a forty-nine dollar onboarding fee for her equipment kit. We can do the interview over Telegram.",
  },
]

function renderStatic() {
  $('cand-name').textContent = CANDIDATE.name
  $('cand-headline').textContent = `${CANDIDATE.headline} · ${CANDIDATE.location}`
  $('cand-phone').textContent = CANDIDATE.agentPhoneDisplay
  $('avatar').textContent = CANDIDATE.name.split(' ').map((p) => p[0]).join('')
  $('call-label').textContent = `Call ${FIRST}'s agent`
  const lines = [
    '6 years of marketplace and fintech analytics',
    'Rebuilt revenue forecasting; monthly close report from 4 days to 1',
    'SQL, Python, dbt, Looker, Tableau, experiment design',
  ]
  $('resume-lines').replaceChildren(...lines.map((t) => el('li', { textContent: t })))

  $('scenarios').replaceChildren(
    ...SCENARIOS.map((s) => {
      const card = el(
        'button',
        { className: 'scenario', type: 'button' },
        el('strong', { textContent: s.title }),
        el('span', { textContent: s.blurb }),
        el('q', { textContent: s.lines })
      )
      card.setAttribute('aria-expanded', 'false')
      card.onclick = () => card.setAttribute('aria-expanded', String(card.getAttribute('aria-expanded') !== 'true'))
      return card
    })
  )

  const r = CANDIDATE.rules
  const words = Object.entries(CANDIDATE.inHerWords).map(([topic, quote]) =>
    el('div', {}, el('strong', { textContent: topic.replace(/_/g, ' ') }), el('blockquote', { textContent: quote }))
  )
  $('knows-body').replaceChildren(
    el('h4', { textContent: `${FIRST}'s requirements, checked by our code` }),
    el(
      'ul',
      {},
      el('li', { textContent: `Minimum pay: $${r.baseFloorAnnual.toLocaleString()} base, or $${r.hourlyFloor} an hour on contract` }),
      el('li', { textContent: `Remote, or hybrid up to ${r.maxOnsiteDaysPerWeek} office days near Austin` }),
      el('li', { textContent: `Deal-breakers: ${r.dealbreakers.join(', ')}` }),
      el('li', { textContent: `Can share her minimum pay with recruiters: ${r.shareFloorWithRecruiters ? 'yes' : 'no'}` })
    ),
    el('h4', { textContent: `In ${FIRST}'s words (recorded ${formatDate(CANDIDATE.recordedOn)})` }),
    ...words,
    el('h4', { textContent: 'Applications' }),
    el(
      'table',
      {},
      ...APPLICATIONS.map((a) =>
        el(
          'tr',
          {},
          el('td', { textContent: a.company }),
          el('td', { textContent: a.role }),
          el('td', { textContent: formatDate(a.appliedOn) })
        )
      )
    )
  )
}

// ---- facts panel -----------------------------------------------------------

const PAY_TAG = {
  meets_floor: ['ok', 'meets her minimum'],
  top_meets_floor: ['maybe', 'top end fits'],
  below_floor: ['no', 'below her minimum'],
  declined: ['maybe', 'not shared'],
  dealbreaker: ['no', 'deal-breaker'],
}
const WORK_TAG = { ok: ['ok', 'fits'], dealbreaker: ['no', 'deal-breaker'] }

let lastFacts = {}
function renderFacts(state) {
  const d = state.details
  const fit = overallFit(state, CANDIDATE.rules)
  const company = state.caller.company
  const rows = [
    {
      key: 'company',
      label: 'Company',
      value: company
        ? `${company}${state.application ? ` · applied ${formatDate(state.application.appliedOn)}` : ` · new to ${FIRST}`}`
        : null,
    },
    { key: 'pay', label: 'Pay', value: d.pay ? (d.pay.declined ? 'not shared' : describePay(d.pay)) : null, tag: PAY_TAG[fit.pay.status] },
    { key: 'work', label: 'Work', value: workText(d.work), tag: WORK_TAG[fit.work.status] },
    { key: 'rounds', label: 'Process', value: d.rounds ? `${d.rounds} interview round${d.rounds === 1 ? '' : 's'}` : null },
    { key: 'decision', label: 'Decision', value: decisionText(d) },
    { key: 'contact', label: 'Contact', value: [state.caller.name, state.caller.email].filter(Boolean).join(' · ') || null },
    { key: 'booking', label: 'Booked', value: state.booking?.label || null },
  ]
  $('facts').replaceChildren(
    ...rows.map((row) => {
      const status = row.value ? state.status[row.key] || 'heard' : 'empty'
      const icon = status === 'confirmed' ? '✓' : status === 'empty' ? '·' : '…'
      const li = el(
        'li',
        { className: `fact ${status}` },
        el('span', { className: 'icon', textContent: icon, title: status === 'confirmed' ? 'read back and confirmed by the caller' : status === 'empty' ? 'not yet' : 'heard, not yet read back' }),
        el('span', { className: 'label', textContent: row.label }),
        el('span', { className: 'value', textContent: row.value || '—' }),
        row.value && row.tag ? el('span', { className: `tag ${row.tag[0]}`, textContent: row.tag[1] }) : el('span')
      )
      const sig = `${status}|${row.value}`
      if (lastFacts[row.key] && lastFacts[row.key] !== sig) {
        li.classList.add('flash')
        setTimeout(() => li.classList.remove('flash'), 900)
      }
      lastFacts[row.key] = sig
      return li
    })
  )
}

function renderShield(state, transcript) {
  const verdict = scamVerdict(
    transcript.filter((l) => l.who === 'caller'),
    state.scamFlags.filter((f) => f.by !== 'rule')
  )
  const shield = $('shield')
  shield.className = `shield ${verdict.level}`
  if (verdict.level === 'clear') {
    $('shield-title').textContent = 'Scam check: nothing suspicious'
    $('shield-detail').textContent = 'Our code checks everything the caller says for signs of a scam.'
  } else {
    $('shield-title').textContent = verdict.level === 'scam' ? 'Scam check: ending this call' : 'Scam check: possible warning sign'
    $('shield-detail').textContent = verdict.reasons.map((r) => `${r.label}${r.by === 'rule' ? ' (our code)' : ' (the agent)'}`).join(' · ')
  }
  return verdict
}

// ---- transcript -------------------------------------------------------------

const partialEl = {}
let liveReply = null
let printedReply = null
const ATTACHES_LEFT = /^[.,!?;:%°)\]}…'"’”]/
const NO_SPACE_AFTER = /[([{$\-/'"‘“]$/
function appendDelta(text, delta) {
  if (!delta) return text
  if (!text) return delta
  if (/^\s/.test(delta) || /\s$/.test(text)) return text + delta
  if (ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text + delta
  return text + ' ' + delta
}

function lineNode(who, text, cls = '') {
  const label = { caller: 'You', agent: `${FIRST}'s agent`, tool: 'action', flag: 'scam check' }[who]
  return el('div', { className: `line ${who} ${cls}` }, el('span', { className: 'who', textContent: label }), el('span', { className: 'said', textContent: text }))
}

function clearEmpty() {
  $('transcript').querySelector('.empty')?.remove()
}

function scrollTranscript() {
  const t = $('transcript')
  t.scrollTop = t.scrollHeight
}

function setPartial(who, text) {
  clearEmpty()
  if (partialEl[who]) partialEl[who].querySelector('.said').textContent = text
  else {
    partialEl[who] = lineNode(who, text, 'partial')
    partialEl[who].dataset.text = text
    $('transcript').append(partialEl[who])
  }
  partialEl[who].dataset.text = text
  scrollTranscript()
}

function dropPartial(who) {
  partialEl[who]?.remove()
  delete partialEl[who]
}

function addLine(who, text) {
  clearEmpty()
  if (who === 'caller' || who === 'agent') dropPartial(who)
  $('transcript').append(lineNode(who, text))
  scrollTranscript()
}

function describeTool(name, args, result) {
  switch (name) {
    case 'find_application':
      return result.found ? `matched application: ${result.role}, applied ${result.applied_on}` : `no application at ${args.company}: new opportunity`
    case 'get_candidate_answer':
      return result.quote ? `used ${FIRST}'s own words (${args.topic.replace(/_/g, ' ')})` : `not covered: saved as a question for ${FIRST}`
    case 'record_details':
      return `recorded ${result.recorded?.join(', ') || 'details'}${result.fit && !result.fit.fits ? ' · not a fit' : ''}`
    case 'record_contact':
      return result.ok ? `contact: ${[result.name, result.email].filter(Boolean).join(' · ')}` : 'contact rejected: incomplete'
    case 'confirm_details':
      return args.confirmed ? `caller confirmed the ${args.scope} details` : `caller corrected the ${args.scope}`
    case 'get_open_slots':
      return result.ok ? `offered: ${result.slots.slice(0, 2).map((s) => s.time).join(' / ')}` : `no times offered: ${result.next}`
    case 'book_slot':
      return result.ok ? `booked: ${result.booked}` : `booking refused: ${result.next}`
    case 'flag_scam':
      return `agent flagged: ${SCAM_REASONS[args.reason] || args.reason}`
    case 'end_call':
      return `ending call (${args.reason})`
    default:
      return name
  }
}

// ---- audio (from AssemblyAI's starter) -----------------------------------

const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() { super(); this._ratio = sampleRate / ${WIRE_RATE}; this._pos = 0; this._prev = 0; this._src = null; this._out = null; this._frame = new Int16Array(${CAPTURE_FRAME_SAMPLES}); this._fill = 0; }
    _send(samples, len) {
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        this._frame[this._fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._fill === this._frame.length) { const pcm = this._frame.slice(); this.port.postMessage(pcm.buffer, [pcm.buffer]); this._fill = 0; }
      }
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) { this._send(ch, ch.length); return true; }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) { this._src = new Float32Array(n + 1); this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2); }
      const src = this._src, out = this._out;
      src[0] = this._prev; src.set(ch, 1);
      let outLen = 0, pos = this._pos;
      while (pos < n) { const i = Math.floor(pos); const frac = pos - i; out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac; pos += this._ratio; }
      this._pos = pos - n; this._prev = ch[n - 1];
      if (outLen) this._send(out, outLen);
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`

const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30); this._writePos = 0; this._readPos = 0; this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate; this._rsPos = 0; this._rsPrev = 0; this._drained = false;
      this._cushion = Math.round(sampleRate * ${PLAYBACK_CUSHION_MS} / 1000); this._maxWait = Math.round(sampleRate * ${PLAYBACK_MAX_WAIT_MS} / 1000);
      this._playing = false; this._waited = 0;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') { this._writePos = this._readPos = this._available = 0; this._rsPos = this._rsPrev = 0; this._playing = false; this._waited = 0; return; }
        const int16 = new Int16Array(e.data);
        if (!int16.length) return;
        if (this._drained) { this._rsPrev = 0; this._rsPos = 0; this._drained = false; }
        if (this._step === 1) { for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768); return; }
        const n = int16.length; let pos = this._rsPos;
        while (pos < n) { const i = Math.floor(pos); const frac = pos - i; const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768; const b = int16[i] / 32768; this._push(a + (b - a) * frac); pos += this._step; }
        this._rsPos = pos - n; this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) { if (this._available < this._ring.length) { this._ring[this._writePos] = v; this._writePos = (this._writePos + 1) % this._ring.length; this._available++; } }
    process(inputs, outputs) {
      const output = outputs[0]; const out = output[0]; const cap = this._ring.length;
      if (!this._playing && this._available > 0) {
        this._waited += out.length;
        if (this._available >= this._cushion || this._waited >= this._maxWait) { this._playing = true; this._waited = 0; }
      }
      for (let i = 0; i < out.length; i++) {
        if (this._playing && this._available > 0) { out[i] = this._ring[this._readPos]; this._readPos = (this._readPos + 1) % cap; this._available--; }
        else { out[i] = 0; if (this._playing) { this._playing = false; this._drained = true; } }
      }
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`

async function addWorklet(ctx, code, name) {
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(ctx, name)
}

async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const select = $('mic')
  const chosen = select.value
  select.replaceChildren(el('option', { value: '', textContent: 'Default microphone' }))
  inputs.forEach((d, i) => select.append(el('option', { value: d.deviceId, textContent: d.label || `Microphone ${i + 1}` })))
  if (chosen && inputs.some((d) => d.deviceId === chosen)) select.value = chosen
}

// ---- the call ---------------------------------------------------------------

let call = null

function setStatus(state, detail) {
  $('status').className = `status ${state}`
  $('status-text').textContent = detail || state
}

function tick() {
  if (!call?.startedAt) return
  const s = Math.floor((Date.now() - call.startedAt) / 1000)
  $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function resetPanels() {
  lastFacts = {}
  $('transcript').replaceChildren()
  $('inbox-body').replaceChildren(el('p', { className: 'empty', textContent: 'After the call, the recruiter gets an email with the details they confirmed and a calendar invite.' }))
  $('receipt-status').className = 'pill'
  $('receipt-status').textContent = 'waiting'
  $('phone-screen').replaceChildren(el('p', { className: 'empty light', textContent: `After the call, ${FIRST} gets a summary here. She doesn't have to pick up.` }))
  $('checks').hidden = true
  $('elapsed').textContent = '0:00'
}

// The call logic (tool results, scam rules, hanging up) lives in
// core/call.js, which the eval harness runs too. The page adds the socket,
// the microphone, the speaker and the panels.
function pageHooks() {
  return {
    ready(msg) {
      call.startedAt = Date.now()
      console.info('[voice agent] session.ready', msg.session_id)
      call.timer = setInterval(tick, 1000)
      setStatus('listening', 'on the call')
      $('call-btn').disabled = false
      $('call-btn').classList.add('live')
      $('call-label').textContent = 'Hang up'
    },
    status: setStatus,
    flush() {
      call.playback?.port.postMessage('stop')
    },
    audio(base64) {
      const raw = atob(base64)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      call.playback?.port.postMessage(bytes.buffer, [bytes.buffer])
    },
    partial(who, text) {
      setPartial(who, text)
    },
    agentDelta(msg) {
      if (msg.reply_id && msg.reply_id === printedReply) return
      if (msg.reply_id !== liveReply) {
        liveReply = msg.reply_id
        dropPartial('agent')
      }
      setPartial('agent', appendDelta(partialEl.agent?.dataset.text || '', msg.delta))
    },
    line(who, text, msg) {
      if (who === 'agent') printedReply = msg?.reply_id ?? printedReply
      addLine(who, text)
    },
    tool(name, args, result) {
      addLine('tool', describeTool(name, args, result))
    },
    change() {
      renderFacts(call.session.state)
      renderShield(call.session.state, call.session.transcript)
    },
    error(msg, fatal) {
      // Kept in the console and the transcript so it can be reported.
      console.error('[voice agent] session.error', msg)
      const text = `${msg.code || 'error'}: ${msg.message || ''}${msg.param ? ` (${msg.param})` : ''}`
      addLine('flag', `error: ${text}`)
      setStatus('error', text)
      if (fatal) endCall('error')
    },
    ended() {
      endCall('ended')
    },
    hangup() {
      endCall('agent')
    },
  }
}

async function startCall() {
  if (call) return
  resetPanels()
  // Everything below belongs to this call. A late event from an earlier
  // call's socket (it closes up to 2 s after hanging up) is ignored.
  const c = { ws: null, timer: null, startedAt: null, finished: false }
  call = c
  window.__call = c
  const live = () => call === c && !c.finished
  const send = (msg) => c.ws?.readyState === 1 && c.ws.send(JSON.stringify(msg))
  c.session = createCallSession({ candidate: CANDIDATE, applications: APPLICATIONS, send, hooks: pageHooks() })
  renderFacts(c.session.state)
  renderShield(c.session.state, c.session.transcript)
  $('call-btn').disabled = true
  $('mic').disabled = true
  setStatus('connecting', 'connecting')

  try {
    const res = await fetch('/api/token')
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) throw new Error(body.error || 'Could not get a session token. Is ASSEMBLYAI_API_KEY set?')

    c.captureCtx = new AudioContext({ sampleRate: WIRE_RATE })
    c.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
    await Promise.all([c.captureCtx.resume(), c.playbackCtx.resume()])
    c.playback = await addWorklet(c.playbackCtx, PLAYBACK_WORKLET, 'playback')
    c.playback.connect(c.playbackCtx.destination)
    const deviceId = $('mic').value
    c.mic = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    })
    listMics()
    const capture = await addWorklet(c.captureCtx, CAPTURE_WORKLET, 'capture')
    c.captureCtx.createMediaStreamSource(c.mic).connect(capture)

    const url = new URL(WS_URL)
    url.searchParams.set('token', body.token)
    const ws = new WebSocket(url)
    c.ws = ws

    capture.port.onmessage = ({ data }) => {
      if (!live() || !c.session.ready || ws.readyState !== 1) return
      const bytes = new Uint8Array(data)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
    }

    ws.onopen = () => {
      // Inline configuration: the prompt, tools and hints are built from
      // Maya's profile each call, with today's date.
      send({ type: 'session.update', session: buildSession(CANDIDATE, APPLICATIONS, new Date()) })
    }
    ws.onmessage = ({ data }) => live() && c.session.handle(JSON.parse(data))
    ws.onclose = (event) => {
      if (!live()) return
      if (!c.session.ready) {
        // Browsers report a refused token as a bare close (often code 1006).
        console.error('[voice agent] socket closed before session.ready', event.code, event.reason)
        setStatus('error', `connection closed before the call started (code ${event.code}${event.reason ? `: ${event.reason}` : ''}). Check ASSEMBLYAI_API_KEY.`)
        endCall('error')
        return
      }
      endCall('closed')
    }
    ws.onerror = () => {
      if (live()) setStatus('error', 'connection failed')
    }
  } catch (error) {
    if (call !== c) return
    setStatus('error', micProblem(error) || error.message)
    teardownAudio()
    call = null
    $('call-btn').disabled = false
    $('mic').disabled = false
  }
}

// Plain-language help when the browser won't give the page a microphone.
function micProblem(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
    return 'The microphone is blocked. Click the icon left of the address bar, allow the microphone, then reload the page.'
  if (error?.name === 'NotFoundError') return 'No microphone found. Plug one in or pick another one below, then try again.'
  if (error?.name === 'NotReadableError') return 'Another app is using the microphone. Close it and try again.'
  return null
}

function teardownAudio() {
  if (!call) return
  call.playback?.port.postMessage('stop')
  call.mic?.getTracks().forEach((t) => t.stop())
  call.captureCtx?.close().catch(() => {})
  call.playbackCtx?.close().catch(() => {})
}

async function endCall(why) {
  if (!call || call.finished) return
  call.finished = true
  call.session.finish()
  clearInterval(call.timer)
  const { ws } = call
  const { state, transcript } = call.session
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }))
    setTimeout(() => ws.readyState === 1 && ws.close(), 2000)
  }
  teardownAudio()
  dropPartial('caller')
  dropPartial('agent')
  $('call-btn').classList.remove('live')
  $('call-label').textContent = `Call ${FIRST}'s agent`
  $('call-btn').disabled = true
  renderFacts(state)

  if (!transcript.length && why !== 'agent') {
    setStatus('idle', why === 'error' ? $('status-text').textContent : 'ready')
    call = null
    $('call-btn').disabled = false
    $('mic').disabled = false
    return
  }

  setStatus('ending', 'writing the summary')
  let result
  try {
    const res = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: serializeState(state), transcript }),
    })
    if (!res.ok) throw new Error(`finalize failed (${res.status})`)
    result = await res.json()
  } catch (error) {
    // Static hosting or offline: the same code runs here instead.
    const local = finalizeCall({ candidate: CANDIDATE, state, transcript })
    const delivery = { receipt: 'preview', briefing: 'preview', errors: [`computed in the browser: ${error.message}`] }
    noteDelivery(local.briefing, local.receipt, delivery)
    result = { ...local, delivery }
  }
  renderAfter(result, state)
  window.__result = result
  setStatus('idle', 'call ended')
  call = null
  $('call-btn').disabled = false
  $('mic').disabled = false
}

// ---- after the call ---------------------------------------------------------

function renderAfter(result, state) {
  const { receipt, briefing, audit, verdict, delivery } = result

  // Recruiter's inbox
  const pill = $('receipt-status')
  if (receipt) {
    const sent = delivery?.receipt === 'sent'
    pill.className = `pill ${sent ? 'good' : 'warn'}`
    pill.textContent = sent ? 'sent' : 'preview'
    const body = el('div', { className: 'mail-body' })
    body.innerHTML = receipt.html // built by core/report.js, every value escaped
    const actions = el('div', { className: 'mail-actions' })
    if (receipt.ics) {
      const a = el('a', { textContent: 'Calendar invite (.ics)', download: 'call.ics' })
      a.href = URL.createObjectURL(new Blob([receipt.ics], { type: 'text/calendar' }))
      actions.append(a)
    }
    $('inbox-body').replaceChildren(
      el(
        'dl',
        { className: 'mail-meta' },
        el('dt', { textContent: 'From' }),
        el('dd', { textContent: `${CANDIDATE.name}'s agent` }),
        el('dt', { textContent: 'To' }),
        el('dd', { textContent: receipt.to }),
        el('dt', { textContent: 'Subject' }),
        el('dd', { textContent: receipt.subject })
      ),
      body,
      actions,
      el('p', {
        className: 'mail-note',
        textContent: sent ? `Delivered to ${delivery.receiptTo}.` : 'Preview only. Configure email in .env to send it for real.',
      })
    )
  } else {
    const blocked = result.outcome === 'blocked'
    pill.className = `pill ${blocked ? 'bad' : 'warn'}`
    pill.textContent = blocked ? 'blocked' : 'no email'
    $('inbox-body').replaceChildren(
      el('p', {
        className: 'empty',
        textContent: blocked
          ? `No email. This caller was blocked as a likely scam, so nothing about ${FIRST} was confirmed or sent.`
          : "No email: the caller didn't confirm an email address on the call.",
      })
    )
  }

  // Maya's phone
  const now = new Date()
  $('phone-time').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })
  const b = briefing
  const facts = b.facts.map((f) =>
    el('li', {}, el('span', { className: f.status === 'confirmed' ? 'ok' : 'dim', textContent: f.status === 'confirmed' ? '✓ ' : '· ' }), el('span', { className: 'k', textContent: `${f.label}: ` }), f.value)
  )
  const extra = []
  if (b.fit) extra.push(el('li', { className: 'danger', textContent: `Not a fit: ${b.fit.join('; ')}` }))
  if (b.scam) b.scam.reasons.forEach((r) => extra.push(el('li', { className: 'danger', textContent: `⚑ ${r.label}: “${r.evidence}”` })))
  if (b.questions?.length) extra.push(el('li', { className: 'dim', textContent: `They asked: ${b.questions.join('; ')}` }))
  if (b.caller) extra.push(el('li', { className: 'dim', textContent: b.caller }))
  $('phone-screen').replaceChildren(
    el(
      'div',
      { className: `notif ${b.tone}` },
      el('div', { className: 'notif-app' }, el('span', { textContent: 'Talk to My Agent' }), el('span', { textContent: 'now' })),
      el('h4', { textContent: b.title }),
      b.when ? el('div', { className: 'when', textContent: b.when }) : null,
      el('div', { className: 'sub2', textContent: b.subtitle }),
      el('ul', {}, ...facts, ...extra),
      el('div', { className: 'foot2', textContent: `${b.receipt} · ${b.audit}` })
    )
  )

  // Checks
  const items = []
  const ok = (good, title, detail) =>
    el('li', {}, el('span', { className: good ? 'ok' : 'no', textContent: good ? '✓' : '!' }), el('div', {}, el('strong', { textContent: title }), detail ? el('small', { textContent: detail }) : null))
  items.push(
    ok(
      true,
      verdict.level === 'scam' ? 'Scam check: call ended' : verdict.level === 'caution' ? 'Scam check: possible warning sign' : 'Scam check: nothing suspicious',
      verdict.reasons.length ? verdict.reasons.map((r) => `${r.label} (${r.by === 'rule' ? 'our code' : 'the agent'})`).join('; ') : 'No signs of a scam in anything the caller said.'
    )
  )
  items.push(
    ok(
      audit.passed,
      audit.passed ? `Nothing made up about ${FIRST}` : `${audit.unsupported.length} possible made-up claim(s) about ${FIRST}`,
      audit.passed
        ? `Checked ${audit.checked.agentLines} agent lines, ${audit.checked.amounts} amounts and ${audit.checked.quotes} quotes against what ${FIRST} told it and what the caller said.`
        : audit.unsupported.map((u) => `${u.type}: ${u.detail}`).join('; ')
    )
  )
  const confirmedCount = Object.values(state.status).filter((s) => s === 'confirmed').length
  const heardCount = Object.keys(state.status).length
  items.push(ok(true, `The email has only confirmed details: ${confirmedCount} of ${heardCount}`, "Anything the recruiter didn't confirm out loud stays out of the email."))
  if (delivery?.errors?.length) items.push(ok(false, 'Delivery notes', delivery.errors.join('; ')))
  $('checks-list').replaceChildren(...items)
  $('checks').hidden = false
}

// ---- wire up -------------------------------------------------------------------

renderStatic()
renderFacts(createCallState(CANDIDATE, APPLICATIONS))
listMics()
navigator.mediaDevices?.addEventListener?.('devicechange', listMics)
$('call-btn').onclick = () => (call ? endCall('caller') : startCall())
// Closing the tab mid-call: end the session now instead of leaving it open
// (and billed) for the 30-second resume window.
window.addEventListener('pagehide', () => {
  if (call?.ws?.readyState === 1) call.ws.send(JSON.stringify({ type: 'session.end' }))
})
