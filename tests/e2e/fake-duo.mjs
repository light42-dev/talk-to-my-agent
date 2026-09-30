// A stand-in for the Voice Agent API that serves both sides of an eval call:
// Maya's agent and the simulated caller. It replays the scripted calls from
// fake-aai.mjs, but each side only moves on when it "hears" the other side
// through the audio the eval harness bridges between them (a simple energy
// detector stands in for turn detection, a tone stands in for speech). It
// also checks that audio never arrives faster than real time.

import { WebSocketServer } from 'ws'

import { SCENARIOS as SCRIPTS } from './fake-aai.mjs'

// Which script to play, from the caller's own instructions.
const PICK = [
  [/Northwind/, 'booked'],
  [/Global Talent/, 'scam'],
  [/TalentBridge/, 'declined'],
]

function tone(seconds) {
  const n = Math.round(24000 * seconds)
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2)
  return buf.toString('base64')
}
const speech = (text) => tone(Math.min(0.6, 0.1 + text.length * 0.004))

function createDetector({ onStart, onStop }) {
  let speaking = false
  let silentMs = 0
  return (base64) => {
    const buf = Buffer.from(base64, 'base64')
    const n = Math.floor(buf.length / 2)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2)
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, n))
    if (rms > 500) {
      silentMs = 0
      if (!speaking) {
        speaking = true
        onStart()
      }
    } else if (speaking) {
      silentMs += n / 24
      if (silentMs >= 300) {
        speaking = false
        silentMs = 0
        onStop()
      }
    }
  }
}

export function startDuoServer({ port }) {
  const log = { problems: [], calls: [] }
  const wss = new WebSocketServer({ port })
  let waiting = { agent: null, caller: null }

  function makeSession(ws) {
    const s = { ws, inbox: [], waiter: null, audioMs: 0, readyAt: 0, hear: null }
    s.send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
    s.next = (types, timeout = 30000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now()
        let settled = false
        const check = () => {
          if (settled) return
          const i = s.inbox.findIndex((m) => types.includes(m.type))
          if (i >= 0) {
            settled = true
            s.waiter = null
            return resolve(s.inbox.splice(i, 1)[0])
          }
          if (Date.now() - t0 > timeout) {
            settled = true
            s.waiter = null
            return reject(new Error(`timed out waiting for ${types.join(' or ')}`))
          }
          s.waiter = check
          setTimeout(check, 40)
        }
        check()
      })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'input.audio') {
        if (!s.readyAt) {
          log.problems.push(`${s.role}: input.audio before session.ready`)
          return
        }
        s.audioMs += Buffer.from(msg.audio, 'base64').length / 48
        const elapsed = Date.now() - s.readyAt
        if (s.audioMs > elapsed + 300) log.problems.push(`${s.role}: audio faster than real time (${Math.round(s.audioMs)} ms in ${elapsed} ms)`)
        s.hear?.(msg.audio)
        return
      }
      if (msg.type === 'session.end') {
        s.send({ type: 'session.ended', session_duration_seconds: (Date.now() - s.readyAt) / 1000 })
        setTimeout(() => ws.close(), 50)
      }
      s.inbox.push(msg)
      s.waiter?.()
    })
    s.hear = null
    return s
  }

  function listen(s) {
    s.hear = createDetector({
      onStart: () => s.send({ type: 'input.speech.started' }),
      onStop: () => {
        s.send({ type: 'input.speech.stopped' })
        s.inbox.push({ type: '__utterance' })
        s.waiter?.()
      },
    })
  }

  async function runAgent(s, steps) {
    s.readyAt = Date.now()
    s.send({ type: 'session.ready', session_id: 'sess_agent' })
    listen(s)
    let replyN = 0
    let callN = 0
    for (const step of steps) {
      if (step.caller) {
        const got = await s.next(['__utterance', 'conversation.message'])
        if (got.type === '__utterance') s.send({ type: 'transcript.user', text: step.caller })
        else await s.next(['reply.create'])
      } else if (step.expect) {
        const msg = await s.next([step.expect])
        if (step.contains && !JSON.stringify(msg).includes(step.contains)) log.problems.push(`agent: ${step.expect} did not mention ${step.contains}`)
      } else if (step.agent) {
        const replyId = `reply_${++replyN}`
        s.send({ type: 'reply.started', reply_id: replyId })
        s.send({ type: 'reply.audio', data: speech(step.agent) })
        s.send({ type: 'transcript.agent', text: step.agent, reply_id: replyId })
        const ids = []
        for (const tool of step.tools || []) {
          const id = `call_${++callN}`
          ids.push(id)
          s.send({ type: 'tool.call', call_id: id, name: tool.name, arguments: tool.arguments })
        }
        s.send({ type: 'reply.done', reply_id: replyId, status: 'completed' })
        if (step.ends) {
          await s.next(['session.end'])
          return
        }
        for (const id of ids) {
          const result = await s.next(['tool.result'])
          if (result.call_id !== id) log.problems.push(`agent: tool.result for ${result.call_id}, expected ${id}`)
        }
      }
    }
  }

  async function runCaller(s, lines) {
    s.readyAt = Date.now()
    s.send({ type: 'session.ready', session_id: 'sess_caller' })
    listen(s)
    for (let i = 0; ; i++) {
      const got = await s.next(['__utterance', 'conversation.message', 'session.end'], 60000)
      if (got.type === 'session.end') return
      if (got.type === 'conversation.message') await s.next(['reply.create'])
      const line = lines[i] || 'Okay, bye.'
      s.send({ type: 'reply.started', reply_id: `caller_${i}` })
      s.send({ type: 'reply.audio', data: speech(line) })
      s.send({ type: 'transcript.agent', text: line, reply_id: `caller_${i}` })
      if (!lines[i]) s.send({ type: 'tool.call', call_id: `hang_${i}`, name: 'hang_up', arguments: {} })
      s.send({ type: 'reply.done', reply_id: `caller_${i}`, status: 'completed' })
      if (!lines[i]) return
    }
  }

  function startIfPaired() {
    const { agent, caller } = waiting
    if (!agent || !caller) return
    waiting = { agent: null, caller: null }
    const prompt = caller.update.system_prompt || ''
    const name = PICK.find(([re]) => re.test(prompt))?.[1]
    if (!name) {
      log.problems.push('no script matches the caller prompt')
      return
    }
    const steps = SCRIPTS[name]
    log.calls.push(name)
    runAgent(agent.s, steps).catch((e) => log.problems.push(`agent (${name}): ${e.message}`))
    runCaller(caller.s, steps.filter((x) => x.caller).map((x) => x.caller)).catch((e) => log.problems.push(`caller (${name}): ${e.message}`))
  }

  wss.on('connection', (ws, req) => {
    if (!new URL(req.url, 'http://x').searchParams.get('token')) log.problems.push('no token on the socket URL')
    const s = makeSession(ws)
    s.next(['session.update'])
      .then((msg) => {
        const update = msg.session || {}
        const tools = (update.tools || []).map((t) => t.name)
        s.role = tools.includes('hang_up') ? 'caller' : 'agent'
        if (s.role === 'agent' && !(update.system_prompt && update.greeting && tools.includes('find_application'))) log.problems.push('agent: incomplete session.update')
        if (s.role === 'caller' && update.greeting) log.problems.push('caller: should listen first, without a greeting')
        waiting[s.role] = { s, update }
        startIfPaired()
      })
      .catch((e) => log.problems.push(e.message))
  })

  return { wss, log, close: () => new Promise((r) => wss.close(r)) }
}
