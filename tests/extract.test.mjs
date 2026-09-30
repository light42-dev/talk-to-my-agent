import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractDetails } from '../public/core/extract.js'

const NOW = new Date('2026-09-30T05:00:00Z')

test('everything said in one breath, as the speech-to-text writes it', () => {
  const d = extractDetails(
    "The range is $115,000 to $135,000 base, hybrid, 2 days a week in Austin, 4 rounds, and we'll decide by October 20th. My email is jen.park@northwind-analytics.com.",
    { now: NOW, company: 'Northwind Analytics' }
  )
  assert.deepEqual(d, {
    pay_min: 115000,
    pay_max: 135000,
    pay_unit: 'year',
    pay_basis: 'base',
    work_mode: 'hybrid',
    office_days_per_week: 2,
    office_location: 'Austin',
    interview_rounds: 4,
    decision_when: 'by October 20th',
    decision_date: '2026-10-20',
  })
})

test('a sentence split across two caller lines still reads whole once joined', () => {
  const d = extractDetails("Hybrid. 2 days a week in Austin, 4 rounds, and we'll decide by October 20th.", { now: NOW })
  assert.equal(d.work_mode, 'hybrid')
  assert.equal(d.office_days_per_week, 2)
  assert.equal(d.office_location, 'Austin')
  assert.equal(d.interview_rounds, 4)
  assert.equal(d.decision_date, '2026-10-20')
})

test('an hourly W-2 contract, on-site in another city', () => {
  const d = extractDetails("I've got a 12-month W-2 contract, $40 an hour, on-site in Dallas 5 days a week.", { now: NOW })
  assert.equal(d.pay_min, 40)
  assert.equal(d.pay_max, 40)
  assert.equal(d.pay_unit, 'hour')
  assert.equal(d.pay_basis, 'w2_hourly')
  assert.equal(d.work_mode, 'onsite')
  assert.equal(d.office_days_per_week, 5)
  assert.equal(d.office_location, 'Dallas')
})

test('remote, words for numbers, and a decision with no date', () => {
  const d = extractDetails("It's fully remote, three rounds, and we'll decide by the end of next week.", { now: NOW })
  assert.equal(d.work_mode, 'remote')
  assert.equal(d.interview_rounds, 3)
  assert.equal(d.decision_when, 'by the end of next week')
  assert.equal(d.decision_date, undefined)
  assert.equal(d.pay_min, undefined)
})

test('numbers that are not money are not read as pay', () => {
  const d = extractDetails('There are 2 to 3 rounds, and the team is in Denver.', { now: NOW })
  assert.equal(d.pay_min, undefined)
  assert.equal(d.interview_rounds, 3)
})

test('a line with no role details gives nothing', () => {
  assert.deepEqual(extractDetails('Hi, this is Jen Park from Northwind Analytics, about the senior data analyst role.', { now: NOW }), {})
  assert.deepEqual(extractDetails("Yes, that's correct.", { now: NOW }), {})
})

test('a company after "from" is not an office location', () => {
  const d = extractDetails("Hi, this is Jen Park from Northwind Analytics. The range is $115,000 to $135,000 base, hybrid, 2 days a week in Austin.", { now: NOW })
  assert.equal(d.office_location, 'Austin')
  assert.equal(extractDetails('Jen from Northwind Analytics here. Hybrid, a few days.', { now: NOW }).office_location, undefined)
})
