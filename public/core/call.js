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

export function createCallSession({ candidate, applications, send, hooks = {}, now = () => Date.now() }) {
  const emit = (name, ...args) => hooks[name]?.(...args)
  const state = createCallState(candidate, applications, new Date(now()))
  const call = {
    state,
    transcript: [],
    clock: createPlayoutClock(now),
    queue: createToolQueue(send),
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

  // Hang up once the goodbye has played. hooks.hangup ends the call.
  function scheduleHangup() {
    if (call.hangupTimer || call.finished) return
    emit('status', 'ending', 'hanging up')
    call.hangupTimer = setTimeout(() => emit('hangup', 'agent'), call.clock.remainingMs() + 600)
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
        emit('status', 'listening', 'listening')
        break

      case 'reply.started':
        call.queue.event(msg.type)
        call.replyActive = true
        call.replyHadAudio = false
        call.replyText = ''
        call.toolsThisReply = []
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
        }
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
  }

  return call
}
