#!/usr/bin/env node
// Checks your API key and this app's session setup against the real
// AssemblyAI Voice Agent API in about 30 seconds, with no microphone:
//
//   npm run smoke
//
// It opens one session with the same session.update the page sends, waits
// for the greeting, types two caller lines into the conversation
// (conversation.message + reply.create) and checks that the agent calls the
// right tools. About 30 seconds of Voice Agent time, roughly 4 cents.

import { loadEnv } from './env.mjs'
import { FRAME_MS, SILENT_FRAME, openJsonSocket } from './socket.mjs'

loadEnv()
const { APPLICATIONS, CANDIDATE } = await import('../public/core/candidate.js')
const { buildSession } = await import('../public/core/session.js')
const { createCallState, handleToolCall } = await import('../public/core/tools.js')
const { audioSeconds, createToolQueue } = await import('../public/core/protocol.js')
const { mintToken } = await import('../server/handlers.js')

const WS_URL = process.env.AGENTS_WS_URL || 'wss://agents.assemblyai.com/v1/ws'
const t0 = Date.now()
const log = (text) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${text}`)
const results = []
function check(ok, label, detail = '') {
  results.push({ ok, label })
  console.log(`        ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`)
}
function finish() {
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `\n${failed} check(s) failed. Paste this output to get help.` : '\nAll checks passed. The real API accepts this app\'s setup.')
  process.exit(failed ? 1 : 0)
}
setTimeout(() => {
  check(false, 'finished within 2 minutes')
  finish()
}, 120_000).unref()

const key = process.env.ASSEMBLYAI_API_KEY
if (!key) {
  console.error('ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and put your key there.')
  process.exit(1)
}

// 1. Token, exactly as /api/token mints it.
let token
try {
  const { status, body } = await mintToken(key, { maxSeconds: 120 })
  if (status < 200 || status > 299) {
    check(false, 'token minted', `HTTP ${status}: ${body.slice(0, 300)}`)
    finish()
  }
  token = JSON.parse(body).token
  check(Boolean(token), 'token minted')
} catch (error) {
  check(false, 'token minted', `could not reach AssemblyAI: ${error.message}`)
  finish()
}

// 2. Session, with the page's own configuration and tool handlers.
const state = createCallState(CANDIDATE, APPLICATIONS, new Date())
const agentLines = []
const errors = []
let ready = null
let ended = null
let closed = null
let readyAt = 0
let firstAudioAt = 0
let replyActive = false
let awaitingFollowUp = false
let lastReplyDoneAt = 0
let audioOut = 0

const waiters = new Set()
const notify = () => [...waiters].forEach((w) => w())
const ticker = setInterval(notify, 200)
function waitFor(predicate, ms) {
  return new Promise((resolve) => {
    const w = () => {
      if (!predicate()) return
      clearTimeout(timer)
      waiters.delete(w)
      resolve(true)
    }
    const timer = setTimeout(() => {
      waiters.delete(w)
      resolve(false)
    }, ms)
    waiters.add(w)
    w()
  })
}
const quiet = () => !replyActive && !awaitingFollowUp && queue.pending === 0 && Date.now() - lastReplyDoneAt > 1200

const url = new URL(WS_URL)
url.searchParams.set('token', token)
const sock = await openJsonSocket(url, {
  onEvent,
  onClose(event) {
    closed = { code: event?.code, reason: String(event?.reason || '') }
    notify()
  },
})
const queue = createToolQueue((msg) => {
  if (msg.type === 'tool.result') awaitingFollowUp = true
  sock.send(msg)
})

function short(result) {
  const text = JSON.stringify(result)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function onEvent(msg) {
  switch (msg.type) {
    case 'session.ready':
      ready = msg
      readyAt = Date.now()
      log(`session.ready ${msg.session_id}`)
      streamSilence()
      break
    case 'reply.started':
      replyActive = true
      awaitingFollowUp = false
      queue.event('reply.started')
      break
    case 'reply.audio':
      if (!firstAudioAt) firstAudioAt = Date.now()
      audioOut += audioSeconds(msg.data)
      break
    case 'transcript.agent':
      agentLines.push(msg.text)
      log(`agent: ${msg.text}${msg.interrupted ? ' (interrupted)' : ''}`)
      break
    case 'transcript.user':
      log(`heard: ${msg.text}`)
      break
    case 'tool.call': {
      const result = handleToolCall(state, msg.name, msg.arguments || {})
      log(`tool: ${msg.name} ${JSON.stringify(msg.arguments || {})}\n          → ${short(result)}`)
      queue.add(msg.call_id, result)
      break
    }
    case 'reply.done':
      replyActive = false
      lastReplyDoneAt = Date.now()
      queue.event('reply.done', { status: msg.status })
      break
    case 'session.error':
      errors.push(msg)
      log(`session.error ${msg.code}: ${msg.message}${msg.param ? ` (${msg.param})` : ''}`)
      break
    case 'session.ended':
      ended = msg
      break
    default:
      break
  }
  notify()
}

// A live microphone sends audio all the time; this sends silence at real
// time (never faster, which the API rejects).
let silence = null
function streamSilence() {
  const start = Date.now()
  let sent = 0
  silence = setInterval(() => {
    const due = Math.floor((Date.now() - start) / FRAME_MS)
    if (due - sent > 5) sent = due - 1 // after a stall, skip rather than burst
    while (sent < due && sock.open) {
      sock.send({ type: 'input.audio', audio: SILENT_FRAME })
      sent++
    }
  }, FRAME_MS)
}

async function say(text) {
  log(`caller (typed): ${text}`)
  const before = agentLines.length
  sock.send({ type: 'conversation.message', role: 'user', content: text })
  sock.send({ type: 'reply.create' })
  const ok = await waitFor(() => agentLines.length > before && quiet(), 30_000)
  if (!ok) log(awaitingFollowUp ? 'no reply after a tool result within 30 s' : 'no reply within 30 s')
  return ok
}

try {
  await sock.opened
} catch (error) {
  check(false, 'WebSocket opened', error.message)
  finish()
}
sock.send({ type: 'session.update', session: buildSession(CANDIDATE, APPLICATIONS, new Date()) })

const isReady = await waitFor(() => ready || errors.length || closed, 15_000)
if (!ready) {
  const why = errors[0] ? `${errors[0].code}: ${errors[0].message}` : closed ? `socket closed, code ${closed.code} ${closed.reason}` : 'timed out'
  check(false, 'session.ready', isReady ? why : 'timed out after 15 s')
  finish()
}
check(true, 'session.ready')
const config = ready.config || {}
if (config.output?.voice) check(config.output.voice === 'alba', 'voice accepted', config.output.voice)
if (Array.isArray(config.tools)) check(config.tools.length === 9, 'all 9 tools accepted', `${config.tools.length} echoed`)
if (config.input?.keyterms) check(config.input.keyterms.length > 0, 'keyterms accepted', `${config.input.keyterms.length} terms`)

// 3. Greeting.
const greeted = await waitFor(() => agentLines.length > 0 && !replyActive, 20_000)
check(greeted, 'greeting spoken', greeted ? `first audio ${firstAudioAt - readyAt} ms after session.ready` : 'no greeting in 20 s')

// 4. Two caller turns, typed.
await say("Hi, this is Jen Park from Northwind Analytics. I'm calling about the Senior Data Analyst role Maya applied for.")
const found = state.toolLog.find((t) => t.name === 'find_application')
check(Boolean(found), 'agent called find_application', found ? JSON.stringify(found.args) : 'not called')
check(state.application?.id === 'northwind', 'matched her Northwind application')

await say('The base salary range is one hundred fifteen thousand to one hundred thirty-five thousand dollars a year.')
const pay = state.details.pay
check(Boolean(pay && pay.min === 115000 && pay.max === 135000 && pay.unit === 'year'), 'agent recorded the pay range', JSON.stringify(pay))
check(errors.length === 0, 'no session errors', errors.map((e) => e.code).join(', '))

// 5. Clean end.
sock.send({ type: 'session.end' })
const endedOk = await waitFor(() => ended || closed, 8_000)
clearInterval(silence)
clearInterval(ticker)
const billed = Number(ended?.session_duration_seconds)
check(
  Boolean(ended),
  'session ended cleanly',
  ended
    ? Number.isFinite(billed)
      ? `${billed.toFixed(1)} s of session, about $${((billed * 4.5) / 3600).toFixed(3)}`
      : 'session.ended received'
    : endedOk
      ? `socket closed, code ${closed?.code}`
      : 'no session.ended'
)
console.log(`\nAgent audio received: ${audioOut.toFixed(1)} s`)
sock.close()
finish()
