// Tool handlers. The model calls these; this code keeps the call's state,
// validates every value, decides fit, and tells the model what to do next.
// Pure functions, so the browser, the server and the tests share them.

import { dateFromWords } from './extract.js'
import {
  PAY_BASES,
  PAY_UNITS,
  WORK_MODES,
  describePay,
  formatDate,
  isIsoDate,
  isValidEmail,
  normalizeEmail,
  normalizePay,
  normalizePhone,
  openSlots,
  overallFit,
  spellEmail,
} from './facts.js'
import { SCAM_REASONS } from './scam.js'

export const CANDIDATE_TOPICS = [
  'summary',
  'why_looking',
  'skills',
  'leadership',
  'looking_for',
  'work_authorization',
  'notice_period',
  'salary_expectation',
  'availability_to_interview',
  'other',
]

export const END_REASONS = ['booked', 'not_a_fit', 'scam', 'caller_declined', 'wrong_number', 'message_taken', 'other']

// Fields shown on screen and in the receipt, in the order the agent asks.
export const FIELDS = ['company', 'pay', 'work', 'rounds', 'decision', 'contact', 'booking']

export function createCallState(candidate, applications, now = new Date()) {
  return {
    startedAt: now.toISOString(),
    candidate,
    applications,
    application: null,
    caller: { company: null, role: null, name: null, title: null, email: null, phone: null },
    details: {
      pay: null,
      work: null,
      rounds: null,
      decisionDate: null,
      decisionText: null,
      roleStatus: null,
      notes: [],
    },
    // field -> 'captured' | 'confirmed'
    status: {},
    confirmedAt: {},
    detailsConfirmed: false,
    contactConfirmed: false,
    slots: null,
    booking: null,
    scamFlags: [],
    quotesUsed: [],
    openQuestions: [],
    endReason: null,
    toolLog: [],
  }
}

// ---- helpers -----------------------------------------------------------

const clean = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|the|group)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function findApplication(applications, company, role) {
  const query = clean(company)
  if (!query) return null
  const candidates = applications.filter((app) => {
    const names = [clean(app.company), ...(app.aliases || []).map(clean)]
    return names.some((name) => name && (query.includes(name) || name.includes(query)))
  })
  if (candidates.length <= 1) return candidates[0] || null
  const wanted = clean(role)
  return candidates.find((app) => wanted && clean(app.role).includes(wanted)) || candidates[0]
}

export function missingFields(state) {
  const d = state.details
  const missing = []
  if (!state.caller.company) missing.push('company')
  if (!d.pay || (!d.pay.declined && d.pay.min === null && d.pay.max === null)) missing.push('pay range')
  if (!d.work?.mode) missing.push('remote, hybrid or on-site')
  else if (d.work.mode !== 'remote' && !d.work.location) missing.push('office location')
  else if (d.work.mode === 'hybrid' && (d.work.onsiteDays === null || d.work.onsiteDays === undefined))
    missing.push('office days per week')
  if (d.rounds === null) missing.push('number of interview rounds')
  if (!d.decisionDate && !d.decisionText) missing.push(`when ${state.candidate.firstName} will hear back either way`)
  return missing
}

// The read-back is written by code from the stored values, so what the
// caller confirms is exactly what goes into the receipt.
export function readbackSentence(state) {
  const d = state.details
  const parts = []
  if (d.pay) parts.push(d.pay.declined ? 'no pay range shared yet' : describePay(d.pay))
  if (d.work?.mode === 'remote') parts.push('fully remote')
  if (d.work?.mode === 'hybrid') {
    const days = Number.isFinite(d.work.onsiteDays) ? `${d.work.onsiteDays} days a week` : 'some days'
    parts.push(`hybrid, ${days} in ${d.work.location || 'the office'}`)
  }
  if (d.work?.mode === 'onsite') parts.push(`on-site in ${d.work.location || 'the office'}`)
  if (d.rounds !== null) parts.push(`${d.rounds} interview round${d.rounds === 1 ? '' : 's'}`)
  if (d.decisionDate) parts.push(`a decision by ${formatDate(d.decisionDate)}`)
  else if (d.decisionText) parts.push(`a decision ${d.decisionText}`)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`
}

// A field moves to "captured" when first heard, or back to "captured" if a
// confirmed value changes. Repeating the same value keeps it confirmed.
function mark(state, field, changed = true) {
  if (!state.status[field] || changed) {
    state.status[field] = 'captured'
    delete state.confirmedAt[field]
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function fitSummary(fit) {
  return {
    pay: fit.pay.status,
    work: fit.work.status,
    fits: fit.fits,
    reasons: fit.reasons,
  }
}

// ---- handlers ----------------------------------------------------------

const handlers = {
  find_application(state, args) {
    const app = findApplication(state.applications, args.company, args.role)
    const previous = state.caller.company
    state.caller.company = app?.company || args.company || null
    state.caller.role = args.role || app?.role || null
    if (args.caller_name) state.caller.name = String(args.caller_name)
    mark(state, 'company', previous !== state.caller.company)
    if (!app) {
      state.application = null
      return {
        found: false,
        company: state.caller.company,
        next: `${state.candidate.firstName} has not applied to this company. That is fine: treat it as a new opportunity and ask about the pay range.`,
      }
    }
    state.application = app
    return {
      found: true,
      company: app.company,
      role: app.role,
      applied_on: formatDate(app.appliedOn),
      posted_range: app.postedRange,
      posted_location: app.location,
      next: `Say ${state.candidate.firstName} applied for the ${app.role} role on ${formatDate(app.appliedOn)}, then ask about the pay range.`,
    }
  },

  get_candidate_answer(state, args) {
    const topic = CANDIDATE_TOPICS.includes(args.topic) ? args.topic : 'other'
    const words = state.candidate.inHerWords[topic]
    if (topic === 'salary_expectation' && !state.candidate.rules.shareFloorWithRecruiters) {
      return { topic, quote: null, next: `${state.candidate.firstName} prefers to hear the role's range first. Ask for it.` }
    }
    if (!words) {
      const question = args.question || topic
      if (!state.openQuestions.includes(question)) state.openQuestions.push(question)
      return {
        topic,
        quote: null,
        next: `${state.candidate.firstName} has not covered this. Say you will ask her and include it in the written confirmation. Do not guess.`,
      }
    }
    state.quotesUsed.push({ topic, quote: words })
    return {
      topic,
      quote: words,
      recorded_on: formatDate(state.candidate.recordedOn),
      next: `Answer only with this, ideally in her words, for example "In ${state.candidate.firstName}'s words, ...". Add nothing.`,
    }
  },

  record_details(state, args) {
    const d = state.details
    const recorded = []
    let anyChange = false

    const payTouched = ['pay_min', 'pay_max', 'pay_unit', 'pay_basis', 'pay_not_shared'].some((k) => args[k] !== undefined)
    if (payTouched) {
      const prev = d.pay || { min: null, max: null, unit: null, basis: null, declined: false }
      const basis = PAY_BASES.includes(args.pay_basis) ? args.pay_basis : prev.basis
      let unit = PAY_UNITS.includes(args.pay_unit) ? args.pay_unit : prev.unit
      if (!unit) unit = ['w2_hourly', '1099_hourly', 'c2c'].includes(basis) ? 'hour' : 'year'
      const { min, max } = normalizePay(args.pay_min ?? prev.min, args.pay_max ?? prev.max, unit)
      const next = { min, max, unit, basis, declined: args.pay_not_shared === true && min === null && max === null }
      const changed = !same(prev, next)
      d.pay = next
      recorded.push('pay')
      mark(state, 'pay', changed)
      if (changed) anyChange = true
    }

    const workTouched = ['work_mode', 'office_location', 'office_days_per_week'].some((k) => args[k] !== undefined)
    if (workTouched) {
      const prev = d.work || { mode: null, location: null, onsiteDays: null }
      const mode = WORK_MODES.includes(args.work_mode) ? args.work_mode : prev.mode
      const days = args.office_days_per_week !== undefined ? Number(args.office_days_per_week) : prev.onsiteDays
      const next = {
        mode,
        location: args.office_location ?? prev.location,
        onsiteDays: Number.isFinite(days) ? days : mode === 'onsite' ? 5 : null,
      }
      const changed = !same(prev, next)
      d.work = next
      recorded.push('work')
      mark(state, 'work', changed)
      if (changed) anyChange = true
    }

    if (args.interview_rounds !== undefined) {
      const rounds = Math.round(Number(args.interview_rounds))
      if (Number.isFinite(rounds) && rounds > 0 && rounds < 20) {
        const changed = d.rounds !== rounds
        d.rounds = rounds
        recorded.push('rounds')
        mark(state, 'rounds', changed)
        if (changed) anyChange = true
      }
    }

    if (args.decision_date !== undefined || args.decision_when !== undefined) {
      const before = [d.decisionDate, d.decisionText]
      if (args.decision_when) {
        d.decisionText = String(args.decision_when)
        // The model gives the caller's words; code works out the date. Asking
        // the model for YYYY-MM-DD made its replies time out on the voice API.
        d.decisionDate = dateFromWords(args.decision_when, new Date(state.startedAt))
      }
      if (isIsoDate(args.decision_date)) d.decisionDate = args.decision_date
      if (d.decisionDate || d.decisionText) {
        const changed = !same(before, [d.decisionDate, d.decisionText])
        recorded.push('decision')
        mark(state, 'decision', changed)
        if (changed) anyChange = true
      }
    }

    if (args.role_status) d.roleStatus = args.role_status
    if (args.note) d.notes.push(String(args.note))

    // A changed value after a read-back needs reading back again.
    if (anyChange) {
      state.detailsConfirmed = false
      state.detailsChangedAt = state.callerTurns || 0
    }

    const fit = overallFit(state, state.candidate.rules)
    const missing = missingFields(state)
    let next
    if (missing.length) next = `Ask about: ${missing[0]}. One question.`
    else next = `Everything is captured. Read this back in one sentence and ask if it is right: "${readbackSentence(state)}". Then call confirm_details.`
    if (!fit.fits) next += ` After confirming, tell them kindly it is not a fit because ${fit.reasons.join(' and ')}. Do not offer times.`
    return { recorded, fit: fitSummary(fit), missing, readback: readbackSentence(state), next }
  },

  record_contact(state, args) {
    const c = state.caller
    const contactSnapshot = [c.name, c.email, c.phone]
    if (args.name) c.name = String(args.name)
    if (args.title) c.title = String(args.title)
    if (args.phone) {
      const phone = normalizePhone(args.phone)
      if (!phone) return { ok: false, next: 'That phone number looks incomplete. Ask them to repeat it slowly.' }
      c.phone = phone
    }
    if (args.email) {
      const email = normalizeEmail(args.email)
      if (!isValidEmail(email)) {
        return { ok: false, next: 'That email address looks incomplete. Ask them to spell it.' }
      }
      c.email = email
    }
    if (c.name || c.email) {
      const changed = !same(contactSnapshot, [c.name, c.email, c.phone])
      mark(state, 'contact', changed)
      if (changed) {
        state.contactConfirmed = false
        state.contactChangedAt = state.callerTurns || 0
      }
    }
    return {
      ok: true,
      name: c.name,
      email: c.email,
      email_readback: spellEmail(c.email),
      next: c.email
        ? `Read the email back like this: "${spellEmail(c.email)}", and ask if it is right. When they say yes, call confirm_details with scope contact.`
        : 'Ask for the best email for the written confirmation.',
    }
  },

  confirm_details(state, args) {
    const scope = args.scope === 'contact' ? 'contact' : 'details'
    if (args.confirmed !== true) {
      return {
        ok: true,
        next: 'Ask what needs correcting, record the correction, and read it back again.',
      }
    }
    // The caller can only confirm a read-back they have heard: something has
    // to be said by the caller after the change was recorded. (Only counted
    // on a live call, where the call logic counts the caller's lines.)
    const changedAt = scope === 'contact' ? state.contactChangedAt : state.detailsChangedAt
    if (state.trackTurns && changedAt !== undefined && (state.callerTurns || 0) <= changedAt) {
      return {
        ok: false,
        next:
          scope === 'contact'
            ? 'Read the email back the way record_contact spelled it and ask if it is right. Call confirm_details only after they answer.'
            : 'Read back the sentence record_details gave you and ask if it is right. Call confirm_details only after they answer.',
      }
    }
    // What the caller confirms is what goes in the summary email, so it has
    // to be recorded first. An agent that read details back from memory is
    // sent to record them.
    if (scope === 'contact' && !state.caller.email) {
      return {
        ok: false,
        next: 'No email is recorded yet. Call record_contact with the email they gave, read it back the way the tool spells it, then call confirm_details with scope contact.',
      }
    }
    if (scope === 'details') {
      const recordedAny = ['pay', 'work', 'rounds', 'decision'].some((f) => state.status[f])
      const missing = missingFields(state)
      // Missing fields send the agent back once. If the caller really doesn't
      // know, the second try goes through.
      if (!recordedAny || (missing.length && !state.missingAllowed)) {
        if (recordedAny) state.missingAllowed = true
        return {
          ok: false,
          missing,
          next: recordedAny
            ? `Not recorded yet: ${missing.join(', ')}. If the caller told you, record it now (find_application for the company, record_details for the rest) and read back the sentence record_details gives you. If they don't know, call confirm_details again.`
            : 'Nothing is recorded yet. Call record_details now with everything the caller told you about the pay, the work arrangement, the interview rounds and when they will decide. Then read back the sentence it gives you and ask if it is right.',
        }
      }
    }
    const now = new Date().toISOString()
    const fields = scope === 'contact' ? ['contact'] : ['company', 'pay', 'work', 'rounds', 'decision']
    for (const field of fields) {
      if (state.status[field]) {
        state.status[field] = 'confirmed'
        state.confirmedAt[field] = now
      }
    }
    if (scope === 'contact') state.contactConfirmed = true
    else state.detailsConfirmed = true
    const fit = overallFit(state, state.candidate.rules)
    const flagged = state.scamFlags.length > 0
    let next
    let slots
    if (scope === 'contact') {
      next = `Tell them a short written confirmation is on its way${state.booking ? ' with the calendar invite' : ''}, and that if they decide not to move forward, a short reply is enough. Then say goodbye and call end_call.`
    } else if (flagged) {
      next = 'Do not book. End the call politely.'
    } else if (!fit.fits) {
      next = `Tell them kindly it is not a fit because ${fit.reasons.join(' and ')}, and that ${state.candidate.firstName} would be glad to talk if that changes. Then ask for the best email for a short written summary.`
    } else if (!state.booking) {
      // The open times come with the confirmation, so the agent never has to
      // guess them.
      slots = offerSlots(state)
      next = offerText(state, slots)
    } else {
      next = 'Ask for the best email for the written confirmation.'
    }
    return { ok: true, scope, fit: fitSummary(fit), ...(slots ? { slots } : {}), next }
  },

  get_open_slots(state) {
    const problem = bookingProblem(state)
    if (problem) return { ok: false, next: problem }
    const slots = offerSlots(state, 3)
    return { ok: true, slots, next: offerText(state, slots) }
  },

  book_slot(state, args) {
    const problem = bookingProblem(state)
    if (problem) return { ok: false, next: problem }
    if (!state.slots) state.slots = openSlots(state.candidate, new Date(), 3)
    const slot = state.slots.find((s) => s.id === args.slot_id)
    if (!slot) return { ok: false, next: 'That time is not one of the open slots. Offer the open times again.' }
    state.booking = { ...slot, with: state.caller.name || null }
    state.status.booking = 'confirmed'
    state.confirmedAt.booking = new Date().toISOString()
    return {
      ok: true,
      booked: slot.label,
      next: state.caller.email
        ? 'Confirm the time out loud, then wrap up.'
        : 'Confirm the time out loud, then ask for the best email for the written confirmation and calendar invite.',
    }
  },

  flag_scam(state, args) {
    const reason = SCAM_REASONS[args.reason] ? args.reason : 'other'
    state.scamFlags.push({ reason, evidence: String(args.evidence || ''), by: 'agent' })
    return {
      ok: true,
      next: `Say, calmly: "${state.candidate.firstName} doesn't pay for job opportunities or share financial details before a written offer. If the role is real, please send the details in writing." Then say goodbye and call end_call with reason scam.`,
    }
  },

  end_call(state, args) {
    state.endReason = END_REASONS.includes(args.reason) ? args.reason : 'other'
    return { ok: true, next: 'If you have not said goodbye yet, say one short goodbye now. The line closes after you finish.' }
  },
}

// Her next open call times, worked out once per call so every tool offers the
// same ones.
function offerSlots(state, count = 2) {
  if (!state.slots) state.slots = openSlots(state.candidate, new Date(), 3)
  return state.slots.slice(0, count).map((s) => ({ slot_id: s.id, time: s.label }))
}

function offerText(state, slots) {
  const first = state.candidate.firstName
  const times = slots.map((s) => `"${s.time}"`).join(' or ')
  const book = 'Then call book_slot with the slot_id of the one they choose.'
  return slots.length > 2
    ? `These are all of ${first}'s open times: ${times}. Offer only these, word for word. ${book} If none works, say ${first} will email other times.`
    : `Offer these two times, word for word, and no others: ${times}. ${book} If neither works, call get_open_slots.`
}

function bookingProblem(state) {
  if (state.scamFlags.length) return 'Do not book. This call was flagged as a likely scam.'
  if (!state.detailsConfirmed) return 'First read back the details and call confirm_details.'
  const fit = overallFit(state, state.candidate.rules)
  if (!fit.fits) return `Do not book: ${fit.reasons.join(' and ')}. Tell them kindly.`
  return null
}

export const TOOL_NAMES = Object.keys(handlers)

// A red flag found by the rules in scam.js, not by the model. It blocks
// booking the same way the model's own flag does.
export function addRuleFlag(state, { code, evidence }) {
  if (state.scamFlags.some((f) => f.reason === code && f.by === 'rule')) return false
  state.scamFlags.push({ reason: code, evidence: String(evidence || ''), by: 'rule' })
  return true
}

// The part of the call state worth sending to the server. The candidate
// profile and applications stay behind: the server uses its own copy.
export function serializeState(state) {
  return {
    startedAt: state.startedAt,
    applicationId: state.application?.id || null,
    caller: state.caller,
    details: state.details,
    status: state.status,
    confirmedAt: state.confirmedAt,
    detailsConfirmed: state.detailsConfirmed,
    contactConfirmed: state.contactConfirmed,
    booking: state.booking,
    scamFlags: state.scamFlags,
    quotesUsed: state.quotesUsed,
    openQuestions: state.openQuestions,
    endReason: state.endReason,
    toolLog: state.toolLog.slice(-60).map(({ at, name, args }) => ({ at, name, args })),
  }
}

// Rebuilds a full state on the server from what the browser sent.
export function restoreState(saved, candidate, applications) {
  const state = createCallState(candidate, applications, new Date(saved?.startedAt || Date.now()))
  const pick = (value, fallback) => (value === undefined || value === null ? fallback : value)
  state.application = applications.find((a) => a.id === saved?.applicationId) || null
  state.caller = { ...state.caller, ...(saved?.caller || {}) }
  state.details = { ...state.details, ...(saved?.details || {}) }
  state.status = pick(saved?.status, {})
  state.confirmedAt = pick(saved?.confirmedAt, {})
  state.detailsConfirmed = saved?.detailsConfirmed === true
  state.contactConfirmed = saved?.contactConfirmed === true
  state.booking = pick(saved?.booking, null)
  state.scamFlags = Array.isArray(saved?.scamFlags) ? saved.scamFlags : []
  state.quotesUsed = Array.isArray(saved?.quotesUsed) ? saved.quotesUsed : []
  state.openQuestions = Array.isArray(saved?.openQuestions) ? saved.openQuestions : []
  state.endReason = pick(saved?.endReason, null)
  state.toolLog = Array.isArray(saved?.toolLog) ? saved.toolLog : []
  return state
}

export function handleToolCall(state, name, args = {}) {
  const handler = handlers[name]
  let result
  try {
    result = handler ? handler(state, args || {}) : { ok: false, next: `Unknown tool ${name}.` }
  } catch (error) {
    result = { ok: false, next: 'Something went wrong on our side. Carry on without it.', error: String(error.message || error) }
  }
  state.toolLog.push({ at: new Date().toISOString(), name, args, result })
  return result
}
