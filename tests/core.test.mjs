import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APPLICATIONS, CANDIDATE } from '../public/core/candidate.js'
import { extractAmounts } from '../public/core/audit.js'
import { normalizeEmail, isValidEmail, openSlots, zonedTimeToUtc } from '../public/core/facts.js'
import { createToolQueue, createPlayoutClock } from '../public/core/protocol.js'
import { finalizeCall } from '../public/core/report.js'
import { scamVerdict } from '../public/core/scam.js'
import { buildSession } from '../public/core/session.js'
import { TOOL_NAMES, addRuleFlag, createCallState, handleToolCall, restoreState, serializeState } from '../public/core/tools.js'

const NOW = new Date('2026-09-29T15:00:00Z') // a Tuesday, 10:00 in Austin

function newCall() {
  return createCallState(CANDIDATE, APPLICATIONS, NOW)
}

// Runs the happy path a real recruiter call should produce.
function bookedCall() {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind', role: 'Senior Data Analyst', caller_name: 'Jen Park' })
  handleToolCall(s, 'record_details', { pay_min: 115, pay_max: 135, pay_unit: 'year', pay_basis: 'base' })
  handleToolCall(s, 'record_details', { work_mode: 'hybrid', office_location: 'Austin', office_days_per_week: 2 })
  handleToolCall(s, 'record_details', { interview_rounds: 4, decision_date: '2026-10-20' })
  handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  const slots = handleToolCall(s, 'get_open_slots', {})
  assert.equal(slots.ok, true)
  handleToolCall(s, 'book_slot', { slot_id: 'slot_1' })
  handleToolCall(s, 'record_contact', { name: 'Jen Park', email: 'jen dot park at northwind-analytics dot com' })
  handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'contact' })
  handleToolCall(s, 'end_call', { reason: 'booked' })
  return s
}

test('session config: every declared tool has a handler, and fields are within API limits', () => {
  const session = buildSession(CANDIDATE, APPLICATIONS, NOW)
  const declared = session.tools.map((t) => t.name).sort()
  assert.deepEqual(declared, [...TOOL_NAMES].sort())
  for (const tool of session.tools) {
    assert.equal(tool.type, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.match(tool.name, /^[a-z_]+$/)
  }
  assert.ok(session.input.keyterms.length <= 100)
  assert.ok(session.input.transcription_prompt.length <= 1750)
  assert.match(session.system_prompt, /Tuesday, September 29, 2026/)
  assert.match(session.greeting, /AI assistant/)
  assert.equal(typeof session.output.voice, 'string')
})

test('find_application matches loosely and reports when she applied', () => {
  const s = newCall()
  const r = handleToolCall(s, 'find_application', { company: 'northwind analytics inc' })
  assert.equal(r.found, true)
  assert.equal(r.applied_on, 'September 3')
  const miss = handleToolCall(newCall(), 'find_application', { company: 'TalentBridge Staffing' })
  assert.equal(miss.found, false)
})

test('pay said as "one fifteen to one thirty-five" is read as thousands and fits the floor', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  const r = handleToolCall(s, 'record_details', { pay_min: 115, pay_max: 135, pay_unit: 'year', pay_basis: 'base' })
  assert.equal(s.details.pay.min, 115000)
  assert.equal(s.details.pay.max, 135000)
  assert.equal(r.fit.pay, 'top_meets_floor')
  assert.equal(r.missing[0], 'remote, hybrid or on-site')
})

test('an hourly contract below her floor and an on-site role in another city are not a fit', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'TalentBridge Staffing' })
  const r = handleToolCall(s, 'record_details', {
    pay_min: 40,
    pay_max: 40,
    pay_unit: 'hour',
    pay_basis: 'w2_hourly',
    work_mode: 'onsite',
    office_location: 'Dallas',
  })
  assert.equal(r.fit.fits, false)
  assert.equal(r.fit.pay, 'below_floor')
  assert.equal(r.fit.work, 'dealbreaker')
  handleToolCall(s, 'record_details', { interview_rounds: 2, decision_when: 'this week' })
  handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  const slots = handleToolCall(s, 'get_open_slots', {})
  assert.equal(slots.ok, false, 'must refuse to offer times for a role that is not a fit')
})

test('booking is refused until the read-back is confirmed', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  handleToolCall(s, 'record_details', { pay_min: 130000, pay_max: 150000, pay_unit: 'year', pay_basis: 'base', work_mode: 'remote', interview_rounds: 3, decision_when: 'next week' })
  assert.equal(handleToolCall(s, 'book_slot', { slot_id: 'slot_1' }).ok, false)
  handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  assert.equal(handleToolCall(s, 'book_slot', { slot_id: 'slot_1' }).ok, true)
})

test('a correction after the read-back needs a new read-back', () => {
  const s = bookedCall()
  assert.equal(s.status.pay, 'confirmed')
  handleToolCall(s, 'record_details', { pay_min: 110000 })
  assert.equal(s.status.pay, 'captured')
  assert.equal(s.detailsConfirmed, false)
})

test('open slots are weekday call windows in her time zone', () => {
  const slots = openSlots(CANDIDATE, NOW, 3)
  assert.equal(slots.length, 3)
  assert.match(slots[0].label, /^Wednesday, September 30 at 12:00 PM Central$/)
  assert.match(slots[1].label, /4:45 PM Central$/)
  assert.equal(slots[0].start, '2026-09-30T17:00:00.000Z')
  // DST: a date in December is UTC-6, not UTC-5.
  assert.equal(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 12, minute: 0 }, 'America/Chicago').toISOString(), '2026-12-01T18:00:00.000Z')
})

test('spoken email addresses are normalized and validated', () => {
  assert.equal(normalizeEmail('jen dot park at northwind dash analytics dot com'), 'jen.park@northwind-analytics.com')
  assert.equal(normalizeEmail('J-E-N dot P-A-R-K at northwind dash analytics dot com'), 'jen.park@northwind-analytics.com')
  assert.equal(normalizeEmail('j, e, n, dot, p, a, r, k, at, northwind, dash, analytics, dot com'), 'jen.park@northwind-analytics.com')
  assert.equal(normalizeEmail('sam dot ortiz at keystone freight, all one word, dot com'), 'sam.ortiz@keystonefreight.com')
  // An address that is already written out is left alone apart from spaces.
  assert.equal(normalizeEmail(' Ana@x-y.co '), 'ana@x-y.co')
  assert.equal(isValidEmail('jen.park@northwind-analytics.com'), true)
  assert.equal(isValidEmail('jen.park@'), false)
  const r = handleToolCall(newCall(), 'record_contact', { email: 'jen park at' })
  assert.equal(r.ok, false)
})

test('scam rules: hard red flags are caught in the caller’s own words', () => {
  const cases = [
    ["Great news, you're hired. There's just a $49 onboarding fee for your equipment kit.", 'asks_payment'],
    ['To set up payroll I need your bank account details and social security number.', 'asks_bank_or_id'],
    ["We'll mail you a check, deposit it with your mobile app and buy the laptop.", 'check_or_gift_card'],
    ['The interview happens over Telegram chat with our manager.', 'chat_only_interview'],
  ]
  for (const [line, code] of cases) {
    const v = scamVerdict([{ text: line }])
    assert.equal(v.level, 'scam', line)
    assert.ok(v.reasons.some((r) => r.code === code), `${code} for: ${line}`)
  }
  const clean = scamVerdict([{ text: "Hi, it's Jen from Northwind. The range is 115 to 135 base and it's hybrid two days." }])
  assert.equal(clean.level, 'clear')
  // A model-only flag without supporting words is caution, not a scam verdict.
  assert.equal(scamVerdict([], [{ reason: 'asks_payment', evidence: 'they seemed off' }]).level, 'caution')
})

test('a rule flag blocks booking', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  handleToolCall(s, 'record_details', { pay_min: 130000, pay_max: 150000, pay_unit: 'year', pay_basis: 'base', work_mode: 'remote', interview_rounds: 3, decision_when: 'next week' })
  assert.equal(handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' }).ok, true)
  addRuleFlag(s, { code: 'asks_payment', evidence: 'pay a fee for the starter kit' })
  assert.equal(handleToolCall(s, 'get_open_slots', {}).ok, false)
})

test('finalize: a booked call yields a receipt with confirmed facts only, an invite, and a clean audit', () => {
  const s = bookedCall()
  // Something heard but never read back must stay out of the receipt.
  s.details.notes.push('team of six')
  const transcript = [
    { who: 'agent', text: "Hi, you've reached Maya Chen's agent." },
    { who: 'caller', text: "Hi, it's Jen from Northwind about the senior data analyst role." },
    { who: 'agent', text: 'Thanks, Jen. Maya applied for that role on September 3. What is the pay range?' },
    { who: 'caller', text: "It's 115 to 135 base." },
    { who: 'agent', text: "In Maya's words, for full-time roles my floor is 120 thousand base." },
    { who: 'agent', text: "So that's $115,000 to $135,000 base, hybrid two days in Austin, four rounds, and a decision by October 20. Did I get that right?" },
    { who: 'caller', text: 'Yes.' },
  ]
  const out = finalizeCall({ candidate: CANDIDATE, state: restoreState(serializeState(s), CANDIDATE, APPLICATIONS), transcript })
  assert.equal(out.outcome, 'booked')
  assert.equal(out.verdict.level, 'clear')
  assert.equal(out.audit.passed, true, JSON.stringify(out.audit.unsupported))
  assert.ok(out.receipt)
  assert.equal(out.receipt.to, 'jen.park@northwind-analytics.com')
  assert.match(out.receipt.text, /\$115,000–\$135,000 base/)
  assert.match(out.receipt.text, /decide not to move forward, a short reply is enough/)
  assert.doesNotMatch(out.receipt.text, /team of six/)
  assert.match(out.receipt.ics, /BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z/)
  assert.equal(out.briefing.tone, 'good')
})

test('finalize: a scam is blocked by code, gets no receipt, and the briefing says why', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Global Remote Solutions' })
  handleToolCall(s, 'flag_scam', { reason: 'asks_payment', evidence: '$49 onboarding fee' })
  handleToolCall(s, 'end_call', { reason: 'scam' })
  const out = finalizeCall({
    candidate: CANDIDATE,
    state: s,
    transcript: [{ who: 'caller', text: "You're hired! Just pay the $49 onboarding fee for your equipment kit today." }],
  })
  assert.equal(out.outcome, 'blocked')
  assert.equal(out.receipt, null)
  assert.equal(out.briefing.tone, 'danger')
  assert.match(out.briefing.text, /Scam warning signs/)
})

test('audit: invented money, invented quotes and invented bookings are caught', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  const out = finalizeCall({
    candidate: CANDIDATE,
    state: s,
    transcript: [
      { who: 'caller', text: 'What does she want?' },
      { who: 'agent', text: "She's looking for $150,000 base." },
      { who: 'agent', text: "In Maya's words, I led a team of twenty engineers at Google." },
      { who: 'agent', text: "Great, you're booked for Thursday." },
      { who: 'agent', text: 'Maya applied for that role on September 9.' },
    ],
  })
  const types = out.audit.unsupported.map((u) => u.type).sort()
  assert.deepEqual(types, ['amount', 'application', 'booking', 'quote'])
})

test('amounts are extracted from typical agent wording', () => {
  const found = extractAmounts('Her floor is 120 thousand base, or $65/hr on W-2, and they asked for $49.')
  assert.deepEqual(found.map((a) => [a.value, a.unit]).sort(), [[120000, 'year'], [49, 'money'], [65, 'hour']].sort())
})

test('tool results wait for reply.done, and interrupted replies drop them', () => {
  const sent = []
  const q = createToolQueue((m) => sent.push(m))
  q.event('reply.started')
  q.add('call_1', { ok: true })
  assert.equal(sent.length, 0)
  q.event('reply.done', { status: 'completed' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'tool.result')
  assert.equal(sent[0].call_id, 'call_1')
  q.event('reply.started')
  q.add('call_2', { ok: true })
  q.event('reply.done', { status: 'interrupted' })
  q.event('reply.done', { status: 'completed' })
  assert.equal(sent.length, 1)
  // A call that arrives while idle goes straight out.
  q.add('call_3', { ok: true })
  assert.equal(sent.length, 2)
})

test('playout clock counts down queued agent audio', () => {
  let t = 1000
  const clock = createPlayoutClock(() => t)
  clock.add(2)
  t += 500
  assert.equal(clock.remainingMs(), 1500)
  clock.clear()
  assert.equal(clock.remainingMs(), 0)
})

test('an agent that read the details back from memory is sent to record them first', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  const r = handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  assert.equal(r.ok, false)
  assert.match(r.next, /Call record_details now/)
  assert.equal(s.detailsConfirmed, false)
  assert.equal(handleToolCall(s, 'get_open_slots', {}).ok, false)
})

test('a missing detail sends the agent back once; if the caller does not know, the second try goes through', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  handleToolCall(s, 'record_details', { pay_min: 130000, pay_max: 150000, pay_unit: 'year', pay_basis: 'base', work_mode: 'remote', decision_when: 'next week' })
  const first = handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  assert.equal(first.ok, false)
  assert.deepEqual(first.missing, ['number of interview rounds'])
  const second = handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  assert.equal(second.ok, true)
  assert.equal(s.detailsConfirmed, true)
})

test('the confirmation carries her open times, so the agent never has to guess them', () => {
  const s = newCall()
  handleToolCall(s, 'find_application', { company: 'Northwind' })
  handleToolCall(s, 'record_details', { pay_min: 115, pay_max: 135, pay_unit: 'year', pay_basis: 'base', work_mode: 'hybrid', office_location: 'Austin', office_days_per_week: 2, interview_rounds: 4, decision_date: '2026-10-20' })
  const r = handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'details' })
  assert.equal(r.ok, true)
  assert.equal(r.slots.length, 2)
  for (const slot of r.slots) assert.ok(r.next.includes(slot.time), `${slot.time} is in the instruction`)
  assert.match(r.next, /no others/)
  // Asking again gives the same times, plus one more.
  const more = handleToolCall(s, 'get_open_slots', {})
  assert.deepEqual(more.slots.slice(0, 2), r.slots)
  assert.equal(more.slots.length, 3)
  assert.equal(handleToolCall(s, 'book_slot', { slot_id: r.slots[1].slot_id }).booked, r.slots[1].time)
})

test('the email read-back cannot be confirmed before an email is recorded', () => {
  const s = bookedCall()
  s.caller.email = null
  const r = handleToolCall(s, 'confirm_details', { confirmed: true, scope: 'contact' })
  assert.equal(r.ok, false)
  assert.match(r.next, /record_contact/)
})

test('the decision date is worked out by code from the caller’s words', () => {
  const s = newCall()
  handleToolCall(s, 'record_details', { decision_when: 'by October 20th' })
  assert.equal(s.details.decisionDate, '2026-10-20')
  handleToolCall(s, 'record_details', { decision_when: 'by the end of next week' })
  assert.equal(s.details.decisionDate, null, 'a correction without a date clears the old date')
  assert.equal(s.details.decisionText, 'by the end of next week')
})

test('audit: asking to get the caller on her calendar is not a booking claim', () => {
  const s = newCall()
  const lines = (text) => [{ who: 'agent', text }]
  const claims = (text) => finalizeCall({ candidate: CANDIDATE, state: s, transcript: lines(text) }).audit.unsupported.filter((u) => u.type === 'booking')
  assert.equal(claims("Thanks, Jen. Before I get you on her calendar, what's the pay range?").length, 0)
  assert.equal(claims("Great, you're on her calendar for Thursday at noon.").length, 1)
})
