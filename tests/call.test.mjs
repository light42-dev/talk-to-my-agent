import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RESUME_TEXT, STALL_MS, createCallSession } from '../public/core/call.js'
import { APPLICATIONS, CANDIDATE } from '../public/core/candidate.js'

const ONE_SECOND = Buffer.alloc(48000).toString('base64') // 1 s of 24 kHz PCM16

// A call session with a recording socket and a hand-driven clock.
function harness(t, hooks = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1_000_000
  const sent = []
  const hangups = []
  const session = createCallSession({
    candidate: CANDIDATE,
    applications: APPLICATIONS,
    send: (msg) => sent.push(msg),
    hooks: { hangup: (why) => hangups.push(why), ...hooks },
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
const creates = (sent) => sent.filter((m) => m.type === 'reply.create')

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
  reply('r2', { text: 'Got it.', tools: [['record_details', { pay_min: 80000, pay_max: 90000, pay_unit: 'year', pay_basis: 'base', work_mode: 'remote', interview_rounds: 3, decision_when: 'next week' }]] })
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

test('a reply cut off by a noise, with nothing said after it, is picked up again after a quiet spell', (t) => {
  const { session, sent, advance } = harness(t)
  session.handle({ type: 'reply.started', reply_id: 'r1' })
  session.handle({ type: 'reply.audio', data: ONE_SECOND })
  session.handle({ type: 'tool.call', call_id: 'c1', name: 'find_application', arguments: { company: 'Northwind' } })
  session.handle({ type: 'input.speech.started' })
  session.handle({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' })
  session.handle({ type: 'input.speech.stopped' })
  assert.equal(toolResults(sent).length, 0, 'the cut-off reply drops its results, as the docs say')
  advance(STALL_MS.noReply - 100)
  assert.equal(creates(sent).length, 0, 'not before the quiet spell')
  advance(200)
  assert.equal(creates(sent).length, 1)
  assert.equal(creates(sent)[0].instructions, RESUME_TEXT)
  assert.equal(session.stats.recoveries, 1)
  session.finish()
})

test('a caller line the server never answers gets an answer', (t) => {
  const { session, sent, advance, reply } = harness(t)
  reply('r1', { text: 'Who am I speaking with?' })
  advance(1000)
  session.handle({ type: 'input.speech.started' })
  session.handle({ type: 'input.speech.stopped' })
  session.handle({ type: 'transcript.user', text: 'Hi, this is Jen from Northwind.' })
  advance(STALL_MS.callerLine - 1000)
  assert.equal(creates(sent).length, 0, 'the model can take a few seconds to start')
  advance(1100)
  assert.equal(creates(sent).length, 1)
  session.finish()
})

test('no nudge while the caller is thinking or talking, or once the server answers', (t) => {
  const { session, sent, advance, reply } = harness(t)
  reply('r1', { text: "What's the pay range?" })
  advance(20000)
  assert.equal(creates(sent).length, 0, 'after a question, the silence is the caller’s')
  session.handle({ type: 'input.speech.started' })
  advance(12000)
  assert.equal(creates(sent).length, 0, 'not while the caller is talking')
  session.handle({ type: 'input.speech.stopped' })
  session.handle({ type: 'transcript.user', text: "It's 115 to 135 base." })
  advance(1500)
  reply('r2', { text: 'Thank you.', tools: [['record_details', { pay_min: 115000, pay_max: 135000, pay_unit: 'year', pay_basis: 'base' }]] })
  advance(1000 + 800)
  reply('r3', { text: 'Is it remote, hybrid, or on-site?' })
  advance(30000)
  assert.equal(creates(sent).length, 0)
  session.finish()
})

test('tool results that start no reply are followed up after the agent’s audio, a few times at most', (t) => {
  const { session, sent, advance, reply } = harness(t)
  reply('r1', { text: 'Thanks, Jen.', tools: [['find_application', { company: 'Northwind' }]] })
  assert.equal(toolResults(sent).length, 1)
  advance(1000 + STALL_MS.toolResult - 200) // 1 s of audio still playing, then the quiet spell
  assert.equal(creates(sent).length, 0)
  advance(400)
  assert.equal(creates(sent).length, 1)
  advance(60000)
  assert.ok(creates(sent).length <= 4, 'bounded')
  session.finish()
})

test('a reply that ends with no speech and no tool call is followed up', (t) => {
  const { session, sent, advance, reply } = harness(t)
  reply('r1', { text: "What's the pay range?" })
  advance(1000)
  session.handle({ type: 'transcript.user', text: "It's 115 to 135 base, hybrid in Austin, four rounds." })
  reply('r2', { audio: false })
  assert.equal(session.stats.emptyReplies, 1)
  advance(STALL_MS.noReply + 100)
  assert.equal(creates(sent).length, 1)
  session.finish()
})

const PACKED = "The range is $115,000 to $135,000 base, hybrid, 2 days a week in Austin, 4 rounds, and we'll decide by October 20th."

function upToThePayQuestion(session, reply, advance) {
  session.handle({ type: 'transcript.user', text: 'Hi, this is Jen Park from Northwind Analytics.' })
  reply('r1', { text: 'Thanks.', tools: [['find_application', { company: 'Northwind Analytics' }]] })
  reply('r2', { text: "Maya applied on September 3. What's the pay range?" })
  advance(2000) // both replies' audio has played
}

test('when the reply to a packed caller line comes back empty, code records the details and the agent reads them back', (t) => {
  const { session, sent, advance, reply } = harness(t)
  upToThePayQuestion(session, reply, advance)
  session.handle({ type: 'transcript.user', text: PACKED })
  reply('r3', { audio: false })
  advance(STALL_MS.noReply + 100)
  const c = creates(sent)
  assert.equal(c.length, 1)
  assert.match(c[0].instructions, /already recorded/)
  assert.match(c[0].instructions, /Read this back/)
  assert.equal(session.state.details.rounds, 4)
  assert.equal(session.state.details.work.location, 'Austin')
  assert.equal(session.state.status.pay, 'captured', 'recorded, not confirmed: the caller still has to say yes')
  session.finish()
})

test('if replies keep coming back empty, the host is asked for a fresh session that picks up the call', (t) => {
  const plans = []
  const { session, sent, advance, reply } = harness(t, { stuck: (plan) => plans.push(plan) })
  upToThePayQuestion(session, reply, advance)
  session.handle({ type: 'transcript.user', text: PACKED })
  reply('r3', { audio: false })
  advance(STALL_MS.noReply + 100)
  assert.equal(creates(sent).length, 1, 'first, one nudge')
  reply('r4', { audio: false })
  reply('r5', { audio: false })
  advance(STALL_MS.noReply + 100)
  assert.equal(creates(sent).length, 1, 'no more nudges into a stuck session')
  assert.equal(plans.length, 1)
  assert.match(plans[0].greeting, /^Sorry, the line cut out for a second\. So that's \$115,000 to \$135,000 base, hybrid, 2 days a week in Austin, 4 interview rounds, and a decision by October 20\. Did I get that right\?$/)
  assert.match(plans[0].context, /Do not greet the caller/)
  assert.match(plans[0].context, /Caller: The range is/)
  // The host reconnects; the new session starts clean and greets with the plan.
  session.resetForNewSession()
  session.handle({ type: 'session.ready', session_id: 'sess_2' })
  reply('g2', { text: plans[0].greeting })
  session.handle({ type: 'transcript.user', text: "Yes, that's right." })
  reply('r6', { text: 'Great.', tools: [['confirm_details', { confirmed: true, scope: 'details' }]] })
  assert.equal(session.state.detailsConfirmed, true)
  assert.equal(toolResults(sent).at(-1).call_id, 'r6_0')
  session.finish()
})
