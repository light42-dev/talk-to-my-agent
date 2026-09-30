import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createCallSession } from '../public/core/call.js'
import { APPLICATIONS, CANDIDATE } from '../public/core/candidate.js'

const ONE_SECOND = Buffer.alloc(48000).toString('base64') // 1 s of 24 kHz PCM16

// A call session with a recording socket and a hand-driven clock.
function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1_000_000
  const sent = []
  const hangups = []
  const session = createCallSession({
    candidate: CANDIDATE,
    applications: APPLICATIONS,
    send: (msg) => sent.push(msg),
    hooks: { hangup: (why) => hangups.push(why) },
    now: () => clock,
  })
  session.handle({ type: 'session.ready', session_id: 'sess_test' })
  const advance = (ms) => {
    clock += ms
    t.mock.timers.tick(ms)
  }
  const reply = (id, { text, audio = true, tools = [] }) => {
    session.handle({ type: 'reply.started', reply_id: id })
    if (audio) session.handle({ type: 'reply.audio', data: ONE_SECOND })
    if (text) session.handle({ type: 'transcript.agent', text, reply_id: id })
    tools.forEach(([name, args], i) => session.handle({ type: 'tool.call', call_id: `${id}_${i}`, name, arguments: args }))
    session.handle({ type: 'reply.done', reply_id: id, status: 'completed' })
  }
  return { session, sent, hangups, advance, reply }
}

const toolResults = (sent) => sent.filter((m) => m.type === 'tool.result')

test('a red flag the agent ignores rides on the pending tool result, not a second reply', (t) => {
  const { session, sent, reply } = harness(t)
  session.handle({ type: 'transcript.user', text: "You're hired! There's just a $49 onboarding fee for your equipment kit." })
  assert.equal(session.state.scamFlags[0].by, 'rule')
  reply('r1', { text: 'Which company is this?', tools: [['find_application', { company: 'Global Talent Solutions' }]] })
  assert.equal(sent.filter((m) => m.type === 'reply.create').length, 0, 'no reply.create next to a tool result')
  const results = toolResults(sent)
  assert.equal(results.length, 1)
  assert.match(JSON.parse(results[0].result).next, /Do not continue the screening/)
})

test('with no tool result pending, a red flag the agent ignores asks for a reply', (t) => {
  const { session, sent, reply } = harness(t)
  session.handle({ type: 'transcript.user', text: 'Please send your bank account and routing number for payroll.' })
  reply('r1', { text: 'Thanks for calling. Which company are you with?' })
  const creates = sent.filter((m) => m.type === 'reply.create')
  assert.equal(creates.length, 1)
  assert.match(creates[0].instructions, /end_call with reason scam/)
})

test('end_call in the goodbye reply sends no result and hangs up once the goodbye has played', (t) => {
  const { sent, hangups, advance, reply } = harness(t)
  reply('r1', { text: "Thanks, Jen. It's on its way. Goodbye.", tools: [['confirm_details', { confirmed: true, scope: 'contact' }], ['end_call', { reason: 'booked' }]] })
  assert.equal(toolResults(sent).length, 0, 'no result that would invite a second goodbye')
  advance(1500)
  assert.deepEqual(hangups, [])
  advance(200) // 1 s of audio + 600 ms
  assert.deepEqual(hangups, ['agent'])
})

test('end_call behind a filler phrase still lets the agent say goodbye before hanging up', (t) => {
  const { sent, hangups, advance, reply } = harness(t)
  reply('r1', { text: 'One moment.', tools: [['confirm_details', { confirmed: true, scope: 'contact' }], ['end_call', { reason: 'booked' }]] })
  assert.equal(toolResults(sent).length, 2, 'both results go back so the next reply is the goodbye')
  advance(2000)
  assert.deepEqual(hangups, [], 'no hang-up before the goodbye')
  reply('r2', { text: 'A written confirmation is on its way. Take care!' })
  assert.equal(toolResults(sent).length, 2)
  advance(1700)
  assert.deepEqual(hangups, ['agent'])
})

test('turns end fast until the agent asks for an email, then it waits for the whole address', (t) => {
  const { session, sent, reply } = harness(t)
  const modeUpdates = () => sent.filter((m) => m.type === 'session.update' && m.session?.input?.transcription_mode)
  reply('r1', { text: 'Thanks, Jen.', tools: [['find_application', { company: 'Northwind Analytics' }]] })
  assert.equal(modeUpdates().length, 0, 'no switch while screening')
  reply('r2', { text: 'Got it.', tools: [['record_details', { pay_min: 80000, pay_max: 90000, pay_unit: 'year', pay_basis: 'base' }]] })
  assert.equal(modeUpdates().length, 0, 'no switch while recording details')
  reply('r3', { text: 'Thanks.', tools: [['confirm_details', { scope: 'details', confirmed: true }]] })
  const updates = modeUpdates()
  assert.equal(updates.length, 1, 'one switch when the email is next')
  assert.equal(updates[0].session.input.transcription_mode, 'balanced')
  reply('r4', { text: 'What is the best email?', tools: [['record_contact', { name: 'Jen Park' }]] })
  assert.equal(modeUpdates().length, 1, 'no repeated switches')
})

test('a sound from the caller does not cut the agent off; a real interruption does', () => {
  let flushes = 0
  const session = createCallSession({
    candidate: CANDIDATE,
    applications: APPLICATIONS,
    send: () => {},
    hooks: { flush: () => flushes++ },
  })
  session.handle({ type: 'session.ready', session_id: 'sess_test' })
  session.handle({ type: 'reply.started', reply_id: 'r1' })
  session.handle({ type: 'reply.audio', data: ONE_SECOND })
  session.handle({ type: 'input.speech.started' })
  assert.equal(flushes, 0, 'an "uh-huh" or noise keeps the audio playing')
  session.handle({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' })
  assert.equal(flushes, 1, 'the server-confirmed interruption stops it')
  session.finish()
})
