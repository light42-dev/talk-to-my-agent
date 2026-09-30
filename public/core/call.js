// The live-call logic, shared by the demo page and the eval harness so both
// run exactly the same code: tool results sent at the right moment, the scam
// rules run on every caller line, and the line hung up once the goodbye has
// been heard. No DOM and no audio devices here; the host passes hooks.
//
// Events: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference

import { extractDetails } from './extract.js'
import { audioSeconds, createPlayoutClock, createToolQueue } from './protocol.js'
import { scamVerdict } from './scam.js'
import { EMAIL_TRANSCRIPTION_MODE } from './session.js'
import { addRuleFlag, createCallState, handleToolCall, missingFields, readbackSentence } from './tools.js'

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

// If the line stays quiet this long while the agent owes the caller a reply,
// ask for one. A reply that came back with nothing in it, or was cut off by a
// noise, gets no follow-up from the server: it waits for the caller, who is
// waiting for the agent, so that is picked up quickly. After a caller's line
// or tool results the server does reply, but under load it can take 5 to 10
// seconds, and asking early makes the agent speak twice.
export const STALL_MS = { callerLine: 10000, toolResult: 15000, noReply: 1200 }
const MAX_RECOVERIES = 4
export const RESUME_TEXT =
  'Carry on from where the call stopped. If the caller said something you have not answered, answer it. If you were cut off, say your last point again in one short sentence. If you were waiting for a tool result, call that tool again.'

// Which record_details argument fills which field.
const FIELD_OF = {
  pay_min: 'pay',
  pay_max: 'pay',
  pay_unit: 'pay',
  pay_basis: 'pay',
  work_mode: 'work',
  office_location: 'work',
  office_days_per_week: 'work',
  interview_rounds: 'rounds',
  decision_when: 'decision',
  decision_date: 'decision',
}

function askFor(field, firstName) {
  if (field === 'company') return 'Which company are you calling from?'
  if (field === 'pay range') return "What's the pay range for the role?"
  if (field === 'remote, hybrid or on-site') return 'Is the role remote, hybrid, or on-site?'
  if (field === 'office location') return 'Which office would it be?'
  if (field === 'office days per week') return 'How many days a week in the office?'
  if (field === 'number of interview rounds') return 'How many interview rounds are there?'
  return `When will ${firstName} hear back either way?`
}

export function createCallSession({ candidate, applications, send: sendRaw, hooks = {}, now = () => Date.now(), playoutLagMs = () => 0 }) {
  const emit = (name, ...args) => hooks[name]?.(...args)
  const state = createCallState(candidate, applications, new Date(now()))
  // Tools use the caller's line count to tell a heard read-back from one
  // confirmed in the same breath.
  state.trackTurns = true
  state.callerTurns = 0
  const startedAt = now()
  // Every message out goes through here, so the watchdog knows when the agent
  // has been asked to speak (tool results start the next reply on their own).
  const send = (msg) => {
    if (msg.type === 'tool.result' || msg.type === 'reply.create') expectReply('toolResult')
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
    stats: { cutOffs: 0, emptyReplies: 0, recoveries: 0, reconnects: 0 },
    // Caller lines since the agent last recorded details, and how many
    // replies in a row came back with nothing in them.
    unrecorded: [],
    failStreak: 0,
    owesReply: false,
    stallMs: STALL_MS.toolResult,
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
  function expectReply(kind) {
    call.owesReply = true
    call.stallMs = STALL_MS[kind]
    heard()
  }

  // Something happened on the line. The quiet starts once the agent's queued
  // audio has played.
  function heard() {
    call.quietSince = now() + playoutMs()
    if (!call.owesReply || call.finished) return
    clearTimeout(call.stallTimer)
    call.stallTimer = setTimeout(checkStall, call.quietSince + call.stallMs - now())
  }

  function checkStall() {
    call.stallTimer = null
    if (call.finished || call.endRequested || !call.owesReply || call.replyActive) return
    const speaking = call.callerSpeakingSince !== null && now() - call.callerSpeakingSince < 30000
    const wait = speaking ? call.stallMs : call.quietSince + call.stallMs - now()
    if (wait > 0) {
      call.stallTimer = setTimeout(checkStall, wait)
      return
    }
    call.owesReply = false
    // Replies keep coming back empty: the voice session is stuck. A host that
    // can reconnect gets what a fresh session needs to pick up the call.
    if (call.failStreak >= 2 && hooks.stuck && call.stats.reconnects < 2) {
      call.stats.reconnects++
      emit('stuck', resumePlan())
      return
    }
    if (call.stats.recoveries >= MAX_RECOVERIES) return
    call.stats.recoveries++
    // The reply to the caller's words got lost: record what code can read in
    // them, so the agent only has to read it back.
    const rescued = call.stallMs === STALL_MS.toolResult ? null : rescueDetails()
    emit('recover', { log: call.log.slice(-12), rescued: !!rescued })
    send({
      type: 'reply.create',
      instructions: rescued ? `The caller's details are already recorded, so do not call record_details for them. ${rescued.next}` : RESUME_TEXT,
    })
  }

  function rescueDetails() {
    if (!call.unrecorded.length || state.detailsConfirmed) return null
    const found = extractDetails(call.unrecorded.join(' '), { now: new Date(now()), company: state.caller.company })
    const args = Object.fromEntries(Object.entries(found).filter(([key]) => !state.status[FIELD_OF[key]]))
    if (!Object.keys(args).length) return null
    call.unrecorded = []
    const result = handleToolCall(state, 'record_details', args)
    emit('tool', 'record_details', args, result, { byCode: true })
    emit('change')
    return result
  }

  // What a fresh voice session needs to pick up this call: a first line it
  // speaks as is, and the call so far for its prompt.
  function resumePlan() {
    rescueDetails()
    const first = candidate.firstName
    const recorded = readbackSentence(state).replace(/–/g, ' to ')
    const missing = missingFields(state)
    let greeting = 'Sorry, the line cut out for a second. Could you say that last part again?'
    if (!state.detailsConfirmed && recorded) {
      greeting = missing.length
        ? `Sorry, the line cut out for a second. So far I have ${recorded}. ${askFor(missing[0], first)}`
        : `Sorry, the line cut out for a second. So that's ${recorded}. Did I get that right?`
    }
    const said = call.transcript
      .slice(-16)
      .map((l) => `${l.who === 'agent' ? 'You' : 'Caller'}: ${l.text}`)
      .join('\n')
    const context = [
      '',
      '',
      `This call is already in progress. The line dropped for a moment and you are back on it, and you just said: "${greeting}" Do not greet the caller or introduce yourself again.`,
      `The call so far:\n${said}`,
      recorded ? `Recorded so far${state.detailsConfirmed ? ', and confirmed by the caller' : ', not yet confirmed'}: ${recorded}.` : '',
      state.booking ? `Booked: ${state.booking.label}.` : '',
      'Continue the call from here, following the steps above.',
    ].join('\n')
    return { greeting, context }
  }

  // For a host whose voice session closed under a live call.
  call.resumePlan = resumePlan

  // After the host reconnects: the old session's pending results and timers
  // belong to a session that is gone.
  call.resetForNewSession = () => {
    call.queue.clear()
    call.queue = createToolQueue(send)
    call.ready = false
    call.replyActive = false
    call.owesReply = false
    call.failStreak = 0
    call.callerSpeakingSince = null
    call.patientForEmail = false
    call.clock.clear()
    clearTimeout(call.stallTimer)
  }

  function onCallerLine(text) {
    call.transcript.push({ who: 'caller', text, at: new Date(now()).toISOString() })
    if (text.trim()) state.callerTurns++
    if (text.trim()) call.unrecorded = [...call.unrecorded, text].slice(-8)
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
        // results go out below (they start the next reply). A cut-off reply,
        // or one with no speech and no tool call, still owes the caller one.
        const empty = !interrupted && !call.replyHadAudio && !call.replyText.trim() && !call.toolsThisReply.length
        if (empty) {
          call.stats.emptyReplies++
          call.failStreak++
        } else if (call.replyHadAudio || call.toolsThisReply.length) call.failStreak = 0
        call.owesReply = interrupted || empty
        call.stallMs = STALL_MS.noReply
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
        if (!call.replyActive && String(msg.text || '').trim()) expectReply('callerLine')
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
        if (msg.name === 'record_details') call.unrecorded = []
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
