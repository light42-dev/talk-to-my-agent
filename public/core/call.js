// The live-call logic, shared by the demo page and the eval harness so both
// run exactly the same code: tool results sent at the right moment, the scam
// rules run on every caller line, and the line hung up once the goodbye has
// been heard. No DOM and no audio devices here; the host passes hooks.
//
// Events: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference

import { audioSeconds, createPlayoutClock, createToolQueue } from './protocol.js'
import { scamVerdict } from './scam.js'
import { EMAIL_TRANSCRIPTION_MODE } from './session.js'
import { addRuleFlag, createCallState, handleToolCall } from './tools.js'

// Errors that leave the call unusable: a rejected configuration would put a
// generic assistant on the line.
const FATAL_ERRORS = ['invalid_config', 'invalid_value', 'session_expired', 'UNAUTHORIZED', 'FORBIDDEN']

// A reply that says goodbye. end_call can also arrive behind a filler such as
// "one moment", and then the goodbye is still to come.
const GOODBYE =
  /\b(good ?bye|bye|take care|have a (?:good|great|nice|lovely|wonderful) (?:day|one|afternoon|evening|week|weekend)|talk soon|all the best|end the call)\b/i

function nudgeText(flag, firstName) {
  return `The caller just ${flag.label}. Do not continue the screening. Say calmly: "${firstName} doesn't pay for job opportunities or share personal details before a written offer, so I'll end the call here. Take care." Then call end_call with reason scam.`
}

// The server normally starts a reply within 1 to 2 seconds. If the line stays
// quiet this long while the agent owes the caller a reply, ask for one. This
// covers a reply cut off by a noise (its tool results are dropped with it and
// the server waits for the caller, who is waiting for the agent).
export const STALL_MS = 4000
const MAX_RECOVERIES = 4
export const RESUME_TEXT =
  'Carry on from where the call stopped. If the caller said something you have not answered, answer it. If you were cut off, say your last point again in one short sentence. If you were waiting for a tool result, call that tool again.'

export function createCallSession({ candidate, applications, send: sendRaw, hooks = {}, now = () => Date.now(), playoutLagMs = () => 0 }) {
  const emit = (name, ...args) => hooks[name]?.(...args)
  const state = createCallState(candidate, applications, new Date(now()))
  const startedAt = now()
  // Every message out goes through here, so the watchdog knows when the agent
  // has been asked to speak (tool results start the next reply on their own).
  const send = (msg) => {
    if (msg.type === 'tool.result' || msg.type === 'reply.create') expectReply()
    if (msg.type !== 'input.audio') record('out', msg.type, msg.type === 'tool.result' ? msg.call_id : undefined)
    return sendRaw(msg)
  }
  const call = {
    state,
    transcript: [],
    clock: createPlayoutClock(now),
    queue: createToolQueue(send),
    // The last 300 protocol events, without audio, for debugging a call.
    log: [],
    stats: { cutOffs: 0, recoveries: 0 },
    owesReply: false,
    quietSince: 0,
    callerSpeakingSince: null,
    stallTimer: null,
    ready: false,
    sessionId: null,
    replyActive: false,
    replyHadAudio: false,
    replyText: '',
    toolsThisReply: [],
    endRequested: false,
    goodbyePending: false,
    nudge: null,
    hangupTimer: null,
    endFallback: null,
    finished: false,
    handle,
    finish,
  }

  function record(dir, type, detail) {
    call.log.push({ ms: now() - startedAt, dir, type, ...(detail === undefined ? {} : { detail }) })
    if (call.log.length > 300) call.log.shift()
  }

  // How long until the agent's queued audio has played.
  const playoutMs = () => {
    const left = call.clock.remainingMs()
    return left > 0 ? left + playoutLagMs() : 0
  }

  // Hang up once the goodbye has played. hooks.hangup ends the call.
  function scheduleHangup() {
    if (call.hangupTimer || call.finished) return
    emit('status', 'ending', 'hanging up')
    call.hangupTimer = setTimeout(() => emit('hangup', 'agent'), playoutMs() + 600)
  }

  // ---- stall watchdog ----
  function expectReply() {
    call.owesReply = true
    heard()
  }

  // Something happened on the line. The quiet starts once the agent's queued
  // audio has played.
  function heard() {
    call.quietSince = now() + playoutMs()
    if (!call.owesReply || call.finished) return
    clearTimeout(call.stallTimer)
    call.stallTimer = setTimeout(checkStall, call.quietSince + STALL_MS - now())
  }

  function checkStall() {
    call.stallTimer = null
    if (call.finished || call.endRequested || !call.owesReply || call.replyActive) return
    const speaking = call.callerSpeakingSince !== null && now() - call.callerSpeakingSince < 30000
    const wait = speaking ? STALL_MS : call.quietSince + STALL_MS - now()
    if (wait > 0) {
      call.stallTimer = setTimeout(checkStall, wait)
      return
    }
    call.owesReply = false
    if (call.stats.recoveries >= MAX_RECOVERIES) return
    call.stats.recoveries++
    emit('recover', { log: call.log.slice(-12) })
    send({ type: 'reply.create', instructions: RESUME_TEXT })
  }

  function onCallerLine(text) {
    call.transcript.push({ who: 'caller', text, at: new Date(now()).toISOString() })
    emit('line', 'caller', text)
    // The rules run on the caller's own words. A hard red flag blocks booking
    // at once; if the agent doesn't act on it, it is told to end the call.
    const verdict = scamVerdict([{ text }])
    for (const reason of verdict.reasons) {
      if (reason.hard && addRuleFlag(state, { code: reason.code, evidence: text })) {
        emit('line', 'flag', reason.label)
        if (!state.scamFlags.some((f) => f.by === 'agent')) call.nudge = reason
      }
    }
    emit('change')
  }

  function handle(msg) {
    if (call.finished) return
    if (!['reply.audio', 'transcript.user.delta', 'transcript.agent.delta'].includes(msg.type)) {
      record('in', msg.type, msg.status || msg.name || (msg.interrupted ? 'interrupted' : undefined))
    }
    switch (msg.type) {
      case 'session.ready':
        call.ready = true
        call.sessionId = msg.session_id
        emit('ready', msg)
        break

      case 'input.speech.started':
        // Don't cut the agent's audio here. This fires on any sound, including
        // an "uh-huh" or background noise, and the server decides whether it
        // is a real interruption. When it is, reply.done arrives with status
        // "interrupted" and the audio is flushed there.
        call.queue.event(msg.type)
        call.callerSpeakingSince = now()
        heard()
        emit('status', 'listening', 'listening')
        break

      case 'input.speech.stopped':
        call.callerSpeakingSince = null
        heard()
        break

      case 'reply.started':
        call.queue.event(msg.type)
        call.replyActive = true
        call.replyHadAudio = false
        call.replyText = ''
        call.toolsThisReply = []
        call.owesReply = false
        clearTimeout(call.stallTimer)
        emit('status', 'speaking', 'agent speaking')
        break

      case 'reply.audio':
        emit('audio', msg.data)
        call.clock.add(audioSeconds(msg.data))
        call.replyHadAudio = true
        break

      case 'reply.done': {
        call.replyActive = false
        const interrupted = msg.status === 'interrupted'
        if (interrupted) {
          emit('flush')
          call.clock.clear()
          call.stats.cutOffs++
        }
        emit('replyEnd', msg.status)
        // A finished reply leaves the next move to the caller, unless tool
        // results go out below (they start the next reply). A cut-off reply
        // still owes the caller an answer.
        call.owesReply = interrupted
        heard()
        // The agent asked to hang up and has said goodbye: drop any unsent
        // tool results so it doesn't start talking again, then hang up once
        // the goodbye has played. With no transcript yet, audio counts.
        const saidGoodbye = call.replyText.trim() ? GOODBYE.test(call.replyText) : call.replyHadAudio
        const hangingUp = call.endRequested && !interrupted && (saidGoodbye || call.goodbyePending)
        if (hangingUp) call.queue.clear()
        // The rules found a red flag in the caller's words and the agent did
        // not act on it. Tool results about to go out start the next reply on
        // their own, so the instruction rides on them; otherwise ask for a reply.
        const acted = call.toolsThisReply.some((t) => t === 'flag_scam' || t === 'end_call')
        const flag = call.nudge && !interrupted && !acted && !call.endRequested ? call.nudge : null
        if (flag && call.queue.pending) {
          call.nudge = null
          call.queue.amend((result) => ({ ...result, next: nudgeText(flag, candidate.firstName) }))
        }
        call.queue.event('reply.done', { status: msg.status })
        emit('status', 'listening', 'listening')
        if (hangingUp) {
          scheduleHangup()
          break
        }
        // end_call came before the goodbye: its result was just sent, so the
        // next reply is the goodbye.
        if (call.endRequested && !interrupted) {
          call.goodbyePending = true
          break
        }
        if (flag && call.nudge) {
          call.nudge = null
          send({ type: 'reply.create', instructions: nudgeText(flag, candidate.firstName) })
        }
        break
      }

      case 'transcript.user.delta':
        emit('partial', 'caller', msg.text || '')
        break

      case 'transcript.user':
        onCallerLine(msg.text || '')
        // A line said over the agent's reply is its own business; one said
        // after it needs an answer.
        if (!call.replyActive && String(msg.text || '').trim()) expectReply()
        break

      case 'transcript.agent.delta':
        emit('agentDelta', msg)
        break

      case 'transcript.agent':
        call.replyText += `${msg.text || ''} `
        call.transcript.push({ who: 'agent', text: msg.text || '', at: new Date(now()).toISOString() })
        emit('line', 'agent', msg.text || '', msg)
        break

      case 'tool.call': {
        const args = msg.arguments || {}
        const result = handleToolCall(state, msg.name, args)
        call.toolsThisReply.push(msg.name)
        emit('tool', msg.name, args, result)
        if (msg.name === 'end_call') {
          call.endRequested = true
          // Whatever happens next, the line closes within a few seconds.
          call.endFallback = setTimeout(() => scheduleHangup(), 9000)
        }
        if (msg.name === 'flag_scam') call.nudge = null
        // The agent is about to ask for an email address: give the caller
        // time to spell it before the turn ends.
        if (!call.patientForEmail && !state.caller?.email && /\bemail\b/i.test(String(result?.next || ''))) {
          call.patientForEmail = true
          send({ type: 'session.update', session: { input: { transcription_mode: EMAIL_TRANSCRIPTION_MODE } } })
        }
        call.queue.add(msg.call_id, result)
        emit('change')
        break
      }

      // `error` is the connection-level form of the same event.
      case 'session.error':
      case 'error': {
        const fatal = !call.ready || FATAL_ERRORS.includes(msg.code)
        emit('error', msg, fatal)
        break
      }

      case 'session.ended':
        emit('ended', msg)
        break

      default:
        break
    }
  }

  // For hosts that deliver caller lines without speech (typed tests).
  call.addCallerLine = onCallerLine

  function finish() {
    call.finished = true
    clearTimeout(call.hangupTimer)
    clearTimeout(call.endFallback)
    clearTimeout(call.stallTimer)
  }

  return call
}
