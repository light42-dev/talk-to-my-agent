#!/usr/bin/env node
// Bot-vs-bot evaluation on the real AssemblyAI Voice Agent API.
//
// Maya's agent (the same session setup and the same call logic the page runs,
// from public/core) takes calls from simulated callers. Each caller is a
// second Voice Agent session with its own voice, facts and behavior. Audio
// flows between the two sessions in real time, as on a phone line, so every
// caller line goes through streaming speech-to-text. Code then scores each
// call against the scenario's ground truth.
//
//   npm run eval                        every scenario, one call at a time
//   npm run eval -- scam_fee_telegram   only these scenarios (see --list)
//   npm run eval -- --list
//   npm run eval -- --text              typed turns instead of audio: faster, skips speech-to-text
//   npm run eval -- --repeat 2          run each scenario twice
//
// Writes eval/runs/<time>/<scenario>.json (full transcripts) and eval/RESULTS.md.
// Each call is two sessions of one to three minutes: about $0.15 to $0.45 at $4.50 an hour.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { ROOT, loadEnv } from '../scripts/env.mjs'
import { FRAME_BYTES, FRAME_MS, SILENT_FRAME, openJsonSocket } from '../scripts/socket.mjs'

loadEnv()
const { APPLICATIONS, CANDIDATE } = await import('../public/core/candidate.js')
const { createCallSession } = await import('../public/core/call.js')
const { audioSeconds, createPlayoutClock } = await import('../public/core/protocol.js')
const { finalizeCall } = await import('../public/core/report.js')
const { buildSession } = await import('../public/core/session.js')
const { mintToken } = await import('../server/handlers.js')
const { CALLER_TOOLS, SCENARIOS, callerPrompt } = await import('./scenarios.mjs')

const WS_URL = process.env.AGENTS_WS_URL || 'wss://agents.assemblyai.com/v1/ws'
const OUT = process.env.EVAL_OUT_DIR ? resolve(process.env.EVAL_OUT_DIR) : join(ROOT, 'eval')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

// ---- arguments -----------------------------------------------------------------

const argv = process.argv.slice(2)
const opts = { text: argv.includes('--text'), list: argv.includes('--list'), repeat: 1, quiet: argv.includes('--quiet') }
const repeatAt = argv.indexOf('--repeat')
if (repeatAt >= 0) opts.repeat = Math.max(1, Number(argv[repeatAt + 1]) || 1)
const ids = argv.filter((a, i) => !a.startsWith('--') && (repeatAt < 0 || i !== repeatAt + 1))

if (opts.list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(24)} ${s.title}`)
  process.exit(0)
}
const unknown = ids.filter((id) => !SCENARIOS.some((s) => s.id === id))
if (unknown.length) {
  console.error(`Unknown scenario: ${unknown.join(', ')}. See npm run eval -- --list`)
  process.exit(1)
}
const chosen = ids.length ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS
const key = process.env.ASSEMBLYAI_API_KEY
if (!key) {
  console.error('ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and put your key there.')
  process.exit(1)
}

async function token(maxSeconds) {
  const { status, body } = await mintToken(key, { maxSeconds })
  if (status < 200 || status > 299) throw new Error(`token request failed (HTTP ${status}): ${body.slice(0, 200)}`)
  return JSON.parse(body).token
}

function explain(who, msg) {
  if (msg.code === 'concurrency_exceeded') return 'Your AssemblyAI account allows fewer concurrent sessions than the two each eval call needs.'
  return `${who} ${msg.type} ${msg.code}: ${msg.message}${msg.param ? ` (${msg.param})` : ''}`
}

function wsUrl(tok) {
  const url = new URL(WS_URL)
  url.searchParams.set('token', tok)
  return url
}

// ---- the phone line ------------------------------------------------------------

// Carries one side's audio to the other at real time, 20 ms at a time, with
// silence in between, like a phone line. Never faster than real time, which
// the API rejects.
function createLine(send) {
  let chunks = []
  let queued = 0
  let timer = null
  function nextFrame() {
    if (!queued) return SILENT_FRAME
    const out = Buffer.alloc(FRAME_BYTES)
    let offset = 0
    while (offset < FRAME_BYTES && chunks.length) {
      const head = chunks[0]
      const n = Math.min(head.length, FRAME_BYTES - offset)
      head.copy(out, offset, 0, n)
      offset += n
      queued -= n
      if (n === head.length) chunks.shift()
      else chunks[0] = head.subarray(n)
    }
    return out.toString('base64')
  }
  return {
    push(base64) {
      const bytes = Buffer.from(base64, 'base64')
      if (!bytes.length) return
      chunks.push(bytes)
      queued += bytes.length
    },
    clear() {
      chunks = []
      queued = 0
    },
    get queuedMs() {
      return queued / 48 // 24 kHz, 2 bytes a sample
    },
    start() {
      if (timer) return
      const t0 = Date.now()
      let sent = 0
      timer = setInterval(() => {
        const due = Math.floor((Date.now() - t0) / FRAME_MS)
        if (due - sent > 50) sent = due - 1 // after a long stall, skip ahead rather than burst
        let burst = 0
        while (sent < due && burst < 5) {
          send({ type: 'input.audio', audio: nextFrame() })
          sent++
          burst++
        }
      }, FRAME_MS)
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}

// ---- one call --------------------------------------------------------------------

async function runScenario(sc, { text }) {
  const started = Date.now()
  const at = () => Date.now() - started
  const timeline = []
  const note = (who, kind, data = {}) => timeline.push({ t: at(), who, kind, ...data })
  const say = (who, line) => !opts.quiet && console.log(`    ${(at() / 1000).toFixed(1).padStart(6)}s  ${who.padEnd(7)} ${line}`)
  const maxSeconds = sc.maxSeconds || 300
  const latencies = []
  const billed = {}
  const callerSaid = []
  let endedBy = null
  let setupError = null

  const [tokenA, tokenB] = await Promise.all([token(maxSeconds + 60), token(maxSeconds + 60)])
  const done = deferred()
  const endedA = deferred()
  const endedB = deferred()
  let finishing = null
  let maxTimer = null
  let ticker = null
  let a = null // Maya's agent's socket
  let b = null // the caller's socket
  const toA = createLine((msg) => a?.send(msg)) // the caller's voice, into Maya's agent
  const toB = createLine((msg) => b?.send(msg)) // Maya's agent's voice, into the caller
  const forA = [] // typed mode: caller lines waiting for Maya's agent
  const forB = [] // typed mode: agent lines waiting for the caller

  // --- Maya's agent: the page's own session and call logic.
  let aAwaiting = false // a tool result was sent and its follow-up reply hasn't started
  let aAwaitingSince = 0
  let aLastDone = 0
  let turnStart = null
  const sendA = (msg) => {
    if (msg.type === 'tool.result') {
      aAwaiting = true
      aAwaitingSince = Date.now()
    }
    a?.send(msg)
  }
  const session = createCallSession({
    candidate: CANDIDATE,
    applications: APPLICATIONS,
    send: sendA,
    hooks: {
      audio: (data) => !text && toB.push(data),
      flush: () => !text && toB.clear(),
      line(who, line, msg) {
        if (who === 'agent') {
          note('agent', 'said', { text: line, interrupted: Boolean(msg?.interrupted) })
          say('agent', line + (msg?.interrupted ? ' (interrupted)' : ''))
          if (text) forB.push(line)
        } else if (who === 'caller') {
          note('agent', 'heard', { text: line })
          if (!text) say('heard', line)
        } else {
          note('agent', who, { text: line })
          say(who, line)
        }
      },
      tool(name, args, result) {
        note('agent', 'tool', { name, args, next: result?.next })
        say('tool', `${name} ${JSON.stringify(args)}`)
      },
      error(msg, fatal) {
        note('agent', 'error', { code: msg.code, message: msg.message, param: msg.param })
        say('error', `agent session: ${msg.code} ${msg.message}${msg.param ? ` (${msg.param})` : ''}`)
        if (fatal) {
          setupError = setupError || explain('agent', msg)
          hangUp('error')
        }
      },
      hangup: () => hangUp('agent'),
      recover(info) {
        note('agent', 'recover', { rescued: Boolean(info?.rescued) })
        say('--', `no reply: asked the agent to go on${info?.rescued ? ' (details read by code)' : ''}`)
      },
      // The agent started reading out its notes: its audio stops here.
      muted({ rest }) {
        note('agent', 'muted', { rest })
        say('--', `the agent started reading out its notes: ${rest ? 'the rest of the reply' : 'the reply'} muted`)
      },
      // Replies kept coming back empty, or a reply was muted. Like the page,
      // open a fresh session that picks up the call.
      stuck: (plan) => reconnectAgent(plan),
    },
  })

  async function reconnectAgent(plan) {
    note('agent', 'reconnect', { greeting: plan.greeting, why: plan.why })
    say('--', `${plan.why || 'voice session stuck'}, reconnecting: "${plan.greeting}"`)
    const old = a
    a = null
    // New handlers first: from here on the old session's events,
    // including its session.ended, are ignored.
    const handlers = agentHandlers()
    session.resetForNewSession()
    old?.send({ type: 'session.end' })
    setTimeout(() => old?.close(), 1500)
    try {
      const fresh = await openJsonSocket(wsUrl(await token(maxSeconds + 60)), handlers)
      if (finishing) return fresh.close()
      await fresh.opened
      a = fresh
      const config = buildSession(CANDIDATE, APPLICATIONS, new Date())
      a.send({ type: 'session.update', session: { ...config, system_prompt: config.system_prompt + plan.context, greeting: plan.greeting } })
    } catch (error) {
      setupError = setupError || `reconnect failed: ${error.message}`
      hangUp('error')
    }
  }


  // A session that closes or ends on its own ends the call for both sides.
  let aReady = false
  function lost(who, ready) {
    if (finishing) return
    if (!ready) setupError = setupError || `the ${who} session closed before it was ready`
    hangUp(`${who} session closed`)
  }

  let agentGen = 0
  function agentHandlers() {
    const gen = ++agentGen
    return {
    onEvent(msg) {
      if (gen !== agentGen) return
      switch (msg.type) {
        case 'session.ready':
          aReady = true
          note('agent', 'ready', { session_id: msg.session_id })
          toA.start() // in typed mode this carries silence: a live line always has audio
          break
        case 'input.speech.started':
          turnStart = null
          break
        case 'input.speech.stopped':
          turnStart = Date.now()
          break
        case 'reply.started':
          aAwaiting = false
          break
        case 'reply.audio':
          if (turnStart) {
            latencies.push(Date.now() - turnStart)
            turnStart = null
          }
          break
        case 'reply.done':
          aLastDone = Date.now()
          break
        case 'session.ended':
          billed.agent = msg.session_duration_seconds ?? null
          endedA.resolve()
          lost('agent', aReady)
          break
        default:
          break
      }
      if (msg.type === 'reply.done') note('agent', 'reply.done', { status: msg.status })
      session.handle(msg)
    },
    onClose() {
      if (gen !== agentGen) return
      // The service closed the line mid-call: pick it up like the page does.
      if (!finishing && aReady && !session.endRequested && session.stats.reconnects < 2) {
        session.stats.reconnects++
        reconnectAgent(session.resumePlan())
        return
      }
      endedA.resolve()
      lost('agent', aReady)
    },
    }
  }
  a = await openJsonSocket(wsUrl(tokenA), agentHandlers())

  // --- The simulated caller: a second session with its own voice.
  let bReady = false
  let bReplyActive = false
  let bLastDone = 0
  let bHadAudio = false
  let bHangup = false
  let bHangTimer = null
  const bClock = createPlayoutClock()
  b = await openJsonSocket(wsUrl(tokenB), {
    onEvent(msg) {
      switch (msg.type) {
        case 'session.ready':
          bReady = true
          note('caller', 'ready', { session_id: msg.session_id })
          toB.start()
          break
        case 'reply.started':
          bReplyActive = true
          bHadAudio = false
          break
        case 'reply.audio':
          bHadAudio = true
          bClock.add(audioSeconds(msg.data))
          if (!text) toA.push(msg.data)
          break
        case 'reply.done':
          bReplyActive = false
          bLastDone = Date.now()
          if (msg.status === 'interrupted') {
            toA.clear()
            bClock.clear()
          }
          if (bHangup && !bHangTimer) bHangTimer = setTimeout(() => hangUp('caller'), bClock.remainingMs() + 600)
          break
        case 'transcript.agent':
          callerSaid.push(msg.text)
          note('caller', 'said', { text: msg.text, interrupted: Boolean(msg.interrupted) })
          say('caller', msg.text + (msg.interrupted ? ' (interrupted)' : ''))
          if (text && msg.text) forA.push(msg.text)
          break
        case 'transcript.user':
          note('caller', 'heard', { text: msg.text })
          break
        case 'tool.call':
          if (msg.name === 'hang_up') {
            bHangup = true
            note('caller', 'hang_up')
            // No tool.result: a result would only make it speak again.
            setTimeout(() => hangUp('caller'), 8000)
          }
          break
        case 'session.error':
        case 'error':
          note('caller', 'error', { code: msg.code, message: msg.message, param: msg.param })
          say('error', `caller session: ${msg.code} ${msg.message}${msg.param ? ` (${msg.param})` : ''}`)
          if (!bReady) {
            setupError = setupError || explain('caller', msg)
            hangUp('error')
          }
          break
        case 'session.ended':
          billed.caller = msg.session_duration_seconds ?? null
          endedB.resolve()
          lost('caller', bReady)
          break
        default:
          break
      }
    },
    onClose() {
      endedB.resolve()
      lost('caller', bReady)
    },
  })

  // --- Typed mode: whole turns are passed as text once each side is idle.
  const aIdle = () =>
    !session.replyActive &&
    (!aAwaiting || Date.now() - aAwaitingSince > 4000) &&
    session.queue.pending === 0 &&
    Date.now() - aLastDone > 700
  const bIdle = () => !bReplyActive && Date.now() - bLastDone > 500
  ticker = setInterval(() => {
    if (!text || finishing) return
    if (forB.length && aIdle() && bIdle()) {
      const content = forB.splice(0).join(' ')
      b.send({ type: 'conversation.message', role: 'user', content })
      b.send({ type: 'reply.create' })
    } else if (forA.length && bIdle() && aIdle()) {
      const lines = forA.splice(0)
      for (const line of lines) session.addCallerLine(line)
      a?.send({ type: 'conversation.message', role: 'user', content: lines.join(' ') })
      a?.send({ type: 'reply.create' })
      turnStart = Date.now()
    }
  }, 150)

  function hangUp(why) {
    if (finishing) return finishing
    endedBy = why
    note('harness', 'hangup', { why })
    say('--', `call ended by ${why}`)
    finishing = (async () => {
      session.finish()
      clearInterval(ticker)
      clearTimeout(maxTimer)
      clearTimeout(bHangTimer)
      toA.stop()
      toB.stop()
      a?.send({ type: 'session.end' })
      b?.send({ type: 'session.end' })
      await Promise.race([Promise.all([endedA.promise, endedB.promise]), sleep(5000)])
      a?.close()
      b?.close()
      done.resolve()
    })()
    return finishing
  }
  maxTimer = setTimeout(() => hangUp('timeout'), maxSeconds * 1000)

  try {
    await Promise.all([a.opened, b.opened])
  } catch (error) {
    setupError = `WebSocket failed to open: ${error.message}`
    hangUp('error')
  }
  if (!setupError) {
    a.send({ type: 'session.update', session: buildSession(CANDIDATE, APPLICATIONS, new Date()) })
    // No greeting: the caller listens first, like a person who just dialed.
    b.send({
      type: 'session.update',
      session: { system_prompt: callerPrompt(sc), tools: CALLER_TOOLS, output: { voice: sc.voice || 'michael' } },
    })
  }
  await done.promise

  const state = session.state
  const result = finalizeCall({ candidate: CANDIDATE, state, transcript: session.transcript })
  const checks = setupError ? [{ name: 'setup', ok: false, detail: setupError }] : score(sc, state, result, { endedBy })
  return {
    id: sc.id,
    title: sc.title,
    mode: text ? 'text' : 'audio',
    startedAt: new Date(started).toISOString(),
    seconds: Math.round(at() / 1000),
    endedBy,
    ok: checks.every((c) => c.ok),
    checks,
    outcome: result.outcome,
    latencies,
    billed,
    stats: session.stats,
    receipt: result.receipt ? { to: result.receipt.to, subject: result.receipt.subject, text: result.receipt.text } : null,
    briefing: result.briefing?.text || null,
    verdict: result.verdict,
    audit: result.audit,
    state: {
      application: state.application?.id || null,
      caller: state.caller,
      details: state.details,
      status: state.status,
      booking: state.booking,
      scamFlags: state.scamFlags,
      quotesUsed: state.quotesUsed.map((q) => q.topic),
      openQuestions: state.openQuestions,
      endReason: state.endReason,
    },
    transcript: session.transcript,
    callerSaid,
    toolLog: state.toolLog.map(({ name, args, result: r }) => ({ name, args, next: r?.next })),
    timeline,
  }
}

// ---- scoring ------------------------------------------------------------------

const FACT_CHECKS = ['application', 'pay', 'pay basis', 'work', 'rounds', 'decision']

function score(sc, state, result, { endedBy }) {
  const e = sc.expect
  const d = state.details
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })

  add('outcome', result.outcome === e.outcome, `${result.outcome}${result.outcome === e.outcome ? '' : `, expected ${e.outcome}`}`)
  if ('application' in e) {
    const got = state.application?.id || null
    add('application', got === e.application, got ? `matched ${got}` : 'new company')
  }
  if (e.pay) {
    const p = d.pay
    const ok = p && p.min === e.pay.min && p.max === e.pay.max && (!e.pay.unit || p.unit === e.pay.unit)
    add('pay', ok, p ? `${p.min}–${p.max} per ${p.unit}${ok ? '' : `, expected ${e.pay.min}–${e.pay.max} per ${e.pay.unit}`}` : 'not captured')
  }
  if (e.payBasis) add('pay basis', d.pay?.basis === e.payBasis, d.pay?.basis || 'not captured')
  if (e.work) {
    const w = d.work
    const ok =
      w &&
      w.mode === e.work.mode &&
      (e.work.onsiteDays === undefined || w.onsiteDays === e.work.onsiteDays) &&
      (!e.work.location || String(w.location || '').toLowerCase().includes(e.work.location))
    add('work', ok, w ? [w.mode, w.onsiteDays != null && w.mode === 'hybrid' ? `${w.onsiteDays} days` : null, w.location].filter(Boolean).join(', ') : 'not captured')
  }
  if (e.rounds !== undefined) add('rounds', d.rounds === e.rounds, d.rounds === null ? 'not captured' : `${d.rounds}${d.rounds === e.rounds ? '' : `, expected ${e.rounds}`}`)
  if (e.decisionDate) {
    add('decision', d.decisionDate === e.decisionDate, d.decisionDate || d.decisionText || 'not captured')
  } else if (e.decision) {
    add('decision', Boolean(d.decisionDate || d.decisionText), d.decisionDate || d.decisionText || 'not captured')
  }
  if (e.email) add('email', state.caller.email === e.email, state.caller.email || 'not captured')
  if ('receipt' in e) add('summary email', Boolean(result.receipt) === e.receipt, result.receipt ? `to ${result.receipt.to}` : 'none')
  if ('invite' in e) add('invite', Boolean(result.receipt?.ics) === e.invite, result.receipt?.ics ? 'attached' : 'none')
  if ('scam' in e) add('scam check', (result.verdict.level === 'scam') === e.scam, result.verdict.level)
  for (const topic of e.quotes || []) {
    add(`answered "${topic.replace(/_/g, ' ')}" in her words`, state.quotesUsed.some((q) => q.topic === topic), state.quotesUsed.map((q) => q.topic).join(', ') || 'no quotes used')
  }
  add('nothing made up', result.audit.passed, result.audit.passed ? `${result.audit.checked.agentLines} agent lines checked` : result.audit.unsupported.map((u) => `${u.type}: ${u.detail}`).join('; '))
  add('agent wrapped up', Boolean(state.endReason), state.endReason ? `end_call ${state.endReason}, line closed by ${endedBy}` : `line closed by ${endedBy}`)
  return checks
}

// ---- report --------------------------------------------------------------------

const pct = (list, p) => {
  if (!list.length) return null
  const sorted = [...list].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const mark = (ok) => (ok ? '✓' : '✗')

function writeResults(runs, dir) {
  const byName = (r, name) => r.checks.find((c) => c.name === name)
  const lat = runs.flatMap((r) => r.latencies)
  const facts = runs.flatMap((r) => r.checks.filter((c) => FACT_CHECKS.includes(c.name)))
  const emails = runs.map((r) => byName(r, 'email')).filter(Boolean)
  const scams = runs.filter((r) => SCENARIOS.find((s) => s.id === r.id)?.expect.scam)
  const unsupported = runs.reduce((n, r) => n + (r.audit?.unsupported?.length || 0), 0)
  const mode = runs[0]?.mode === 'text' ? 'typed turns (no speech-to-text)' : 'spoken turns over a real-time audio bridge'

  const rows = runs.map((r) => {
    const f = r.checks.filter((c) => FACT_CHECKS.includes(c.name))
    const email = byName(r, 'email')
    const scam = byName(r, 'scam check')
    const audit = byName(r, 'nothing made up')
    return `| ${r.id} | ${r.title} | ${mark(byName(r, 'outcome')?.ok)} ${r.outcome} | ${f.length ? `${f.filter((c) => c.ok).length}/${f.length}` : '–'} | ${email ? mark(email.ok) : '–'} | ${scam ? `${mark(scam.ok)} ${scam.detail}` : '–'} | ${audit ? mark(audit.ok) : '–'} | ${r.stats ? `${r.stats.recoveries} nudge${r.stats.recoveries === 1 ? '' : 's'}, ${r.stats.reconnects} reconnect${r.stats.reconnects === 1 ? '' : 's'}` : '–'} | ${mmss(r.seconds)} | ${pct(r.latencies, 50) ?? '–'} ms |`
  })
  const failures = runs.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `- **${r.id}**, ${c.name}: ${c.detail}`))

  const md = `# Eval results

Maya's agent took **${runs.length} calls** from simulated callers on the real AssemblyAI Voice Agent API on ${new Date().toISOString().slice(0, 10)}, with ${mode}. Each caller is a second Voice Agent session with its own voice, facts and behavior (\`eval/scenarios.mjs\`). Maya's agent ran the same session setup and call logic as the demo page. Every check is computed by code from the call's final state (\`eval/run.mjs\`), not judged by a model.

| Call | What it tests | Outcome | Facts right | Email | Scam check | Nothing made up | Picked up after a dropped reply | Length | Reply latency (median) |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

**Totals:** ${runs.filter((r) => r.ok).length} of ${runs.length} calls passed every check. Outcomes right: ${runs.filter((r) => byName(r, 'outcome')?.ok).length}/${runs.length}. Facts right: ${facts.filter((c) => c.ok).length}/${facts.length}. Emails right: ${emails.filter((c) => c.ok).length}/${emails.length}. Scams blocked: ${scams.filter((r) => r.outcome === 'blocked').length}/${scams.length}. Made-up claims about Maya: ${unsupported}. Dropped replies picked up: ${runs.reduce((n, r) => n + (r.stats?.recoveries || 0), 0)} nudges and ${runs.reduce((n, r) => n + (r.stats?.reconnects || 0), 0)} fresh sessions. Replies muted because the agent started reading out its notes: ${runs.reduce((n, r) => n + (r.stats?.muted || 0), 0)}.

**Reply latency:** median ${pct(lat, 50) ?? '–'} ms, p90 ${pct(lat, 90) ?? '–'} ms over ${lat.length} turns, measured from the API's end-of-speech event to the first audio of the agent's reply, including tool calls.

${failures.length ? `## What went wrong\n\n${failures.join('\n')}\n\nFull transcripts: \`${dir}\`.` : 'Every check passed.'}
`
  writeFileSync(join(OUT, 'RESULTS.md'), md)
  return md
}

// ---- main -------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = join(OUT, 'runs', stamp)
const dir = relative(ROOT, runDir).split('\\').join('/') || runDir
mkdirSync(runDir, { recursive: true })
console.log(`Running ${chosen.length * opts.repeat} call(s), ${opts.text ? 'typed' : 'spoken'}, one at a time. Transcripts go to ${dir}.\n`)

const runs = []
for (let round = 1; round <= opts.repeat; round++) {
  for (const sc of chosen) {
    console.log(`${sc.id}: ${sc.title}`)
    let run
    try {
      run = await runScenario(sc, { text: opts.text })
    } catch (error) {
      run = { id: sc.id, title: sc.title, mode: opts.text ? 'text' : 'audio', seconds: 0, ok: false, outcome: 'error', latencies: [], checks: [{ name: 'setup', ok: false, detail: error.message }] }
    }
    runs.push(run)
    const file = join(runDir, `${sc.id}${opts.repeat > 1 ? `-${round}` : ''}.json`)
    writeFileSync(file, JSON.stringify(run, null, 2))
    const failed = run.checks.filter((c) => !c.ok)
    console.log(`  ${run.ok ? 'PASS' : 'FAIL'}  ${run.outcome}, ${run.checks.length - failed.length}/${run.checks.length} checks, ${run.seconds} s${run.latencies.length ? `, median reply ${pct(run.latencies, 50)} ms` : ''}`)
    for (const c of failed) console.log(`        ✗ ${c.name}: ${c.detail}`)
    console.log('')
    if (run.checks.some((c) => c.name === 'setup')) {
      console.log('Stopping: the sessions could not be set up. Fix the error above first.')
      break
    }
  }
}

writeResults(runs, dir)
console.log(`${runs.filter((r) => r.ok).length} of ${runs.length} calls passed every check. Summary: ${relative(ROOT, join(OUT, 'RESULTS.md')).split('\\').join('/')}`)
process.exit(0)
