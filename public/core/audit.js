// After every call, code re-reads what the agent said and checks each claim
// about the candidate against what she actually recorded, what the caller
// said, and what the tools stored. Anything else is reported as unsupported.

import { formatDate } from './facts.js'

const WORD_THOUSAND = /^(k|thousand)$/i

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Money the text mentions with digits: "$120,000", "120 thousand", "120K",
// "65 an hour", "$40/hr". Spelled-out numbers are not checked.
export function extractAmounts(text) {
  const found = []
  const t = String(text || '')
  const hourly = /\$?\s?(\d+(?:\.\d+)?)\s*(?:dollars\s*)?(?:an|per|\/|a)\s*(?:hour|hr)\b/gi
  for (const m of t.matchAll(hourly)) found.push({ value: Number(m[1]), unit: 'hour', text: m[0], at: m.index })
  const yearly = /(\$)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|thousand\b|million\b)?/gi
  for (const m of t.matchAll(yearly)) {
    const [whole, dollar, digits, scale] = m
    if (!dollar && !scale) continue
    if (found.some((f) => m.index >= f.at && m.index < f.at + f.text.length)) continue
    let value = Number(digits.replace(/,/g, ''))
    if (scale && WORD_THOUSAND.test(scale)) value *= 1000
    if (scale && /million/i.test(scale)) value *= 1_000_000
    // "$49" is a fee, "$120,000" is a salary; both are amounts the agent said.
    found.push({ value, unit: value >= 1000 ? 'year' : 'money', text: whole.trim(), at: m.index })
  }
  return found
}

const tokens = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))

const STOP = new Set(
  'the and for her she with that this from have has was are you your our about into just like been will would than then them they their what when which where there here also very really more most some any all each'.split(' ')
)

// Share of the quoted words that appear in her best-matching recorded answer.
export function quoteSupport(quote, recordedAnswers) {
  const words = tokens(quote)
  if (!words.length) return 1
  let best = 0
  for (const answer of recordedAnswers) {
    const pool = new Set(tokens(answer))
    const hit = words.filter((w) => pool.has(w)).length / words.length
    if (hit > best) best = hit
  }
  return best
}

export function auditClaims({ candidate, state, transcript }) {
  const agentLines = transcript.filter((l) => l.who === 'agent').map((l) => l.text)
  const callerLines = transcript.filter((l) => l.who === 'caller').map((l) => l.text)
  const recorded = Object.values(candidate.inHerWords || {})

  const allowed = { year: new Set(), hour: new Set(), money: new Set() }
  const allow = (value, unit) => {
    if (!Number.isFinite(value)) return
    allowed[unit]?.add(value)
    if (unit === 'year') allowed.money.add(value)
  }
  allow(candidate.rules.baseFloorAnnual, 'year')
  allow(candidate.rules.hourlyFloor, 'hour')
  for (const text of [...recorded, ...callerLines]) {
    for (const a of extractAmounts(text)) allow(a.value, a.unit)
    // "120 thousand" in her words without a currency sign, and bare caller
    // numbers like "one fifteen" that the model turned into 115000.
    for (const m of String(text).matchAll(/\b(\d{2,3})\s*(k|thousand)?\b/gi)) {
      const n = Number(m[1])
      allow(n, 'hour')
      allow(n * 1000, 'year')
    }
  }
  const pay = state.details?.pay
  if (pay) {
    for (const v of [pay.min, pay.max]) allow(v, pay.unit === 'hour' ? 'hour' : 'year')
  }
  for (const v of String(state.application?.postedRange || '').match(/\d[\d,]*/g) || []) {
    allow(Number(v.replace(/,/g, '')), 'year')
  }

  const unsupported = []
  let amountsChecked = 0
  let quotesChecked = 0

  for (const line of agentLines) {
    for (const s of sentences(line)) {
      for (const a of extractAmounts(s)) {
        amountsChecked++
        const ok = allowed[a.unit]?.has(a.value) || allowed.money.has(a.value)
        if (!ok) {
          unsupported.push({ type: 'amount', text: s, detail: `${a.text} was not said by the caller or recorded by ${candidate.firstName}` })
        }
      }

      const quote = s.match(new RegExp(`in (?:${candidate.firstName}'?s|her) (?:own )?words,?\\s*(.+)`, 'i'))
      if (quote) {
        quotesChecked++
        const support = quoteSupport(quote[1], recorded)
        if (support < 0.6) {
          unsupported.push({ type: 'quote', text: s, detail: `only ${Math.round(support * 100)}% of this matches anything ${candidate.firstName} recorded` })
        }
      }

      if (new RegExp(`\\b(?:she|${candidate.firstName})\\s+(?:accepts|will accept|would accept|agrees to|has agreed|is accepting)\\b`, 'i').test(s)) {
        unsupported.push({ type: 'commitment', text: s, detail: `the agent cannot accept or agree to anything for ${candidate.firstName}` })
      }

      // "You're on her calendar" claims a booking; "before I get you on her
      // calendar" does not.
      if (!state.booking && /\b(you'?re (all )?(booked|set)|i'?ve booked|is booked|(you'?re|you are|it'?s|that'?s|is) (now )?on (her|maya'?s) calendar)\b/i.test(s)) {
        unsupported.push({ type: 'booking', text: s, detail: 'the agent said a time was booked, but nothing was booked' })
      }

      const applied = s.match(/\bapplied\b[^.?!]*?\bon\s+([A-Z][a-z]+ \d{1,2})/)
      if (applied) {
        const expected = state.application ? formatDate(state.application.appliedOn) : null
        if (expected !== applied[1]) {
          unsupported.push({
            type: 'application',
            text: s,
            detail: expected ? `she applied on ${expected}, not ${applied[1]}` : 'there is no application on record for this company',
          })
        }
      }
    }
  }

  return {
    passed: unsupported.length === 0,
    checked: { agentLines: agentLines.length, amounts: amountsChecked, quotes: quotesChecked },
    unsupported,
  }
}
