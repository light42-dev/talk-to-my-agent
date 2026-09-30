// Reads role details straight from the caller's transcribed words, in code.
// The agent normally records details itself with record_details. When the
// voice service drops the agent's reply (it can, after a caller packs many
// details into one breath), the call logic records what this finds and
// hands the agent the exact sentence to read back, so the call keeps going.
//
// Returns record_details arguments, only for what it is sure of.

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const NOT_PLACES = new Set([...MONTHS, 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'the', 'a', 'an', 'our', 'person'])

const AMOUNT = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|thousand\b)?`

function amount(digits, scale) {
  let n = Number(String(digits).replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  if (scale) n *= 1000
  return n
}

function count(word) {
  const w = String(word).toLowerCase()
  return NUMBER_WORDS[w] ?? (Number.isFinite(Number(w)) ? Number(w) : null)
}

function extractPay(text) {
  const out = {}
  const hourly = /\b(an|per|a|\/)\s*(hour|hr)\b|\bhourly\b/i.test(text)
  const range = new RegExp(`${AMOUNT}\\s*(?:to|-|–|and)\\s*${AMOUNT}`, 'i').exec(text)
  // Money needs a dollar sign, a "k" or "thousand", or pay words nearby, so
  // "2 to 3 rounds" is not read as pay.
  const payWords = /\b(range|pay|salary|base|comp|compensation|rate|OTE|dollars?)\b/i.test(text)
  if (range && (/\$/.test(range[0]) || range[2] || range[4] || payWords)) {
    let lo = amount(range[1], range[2] || range[4])
    let hi = amount(range[3], range[4] || range[2])
    if (lo !== null && hi !== null) {
      out.pay_min = lo
      out.pay_max = hi
    }
  } else {
    const single = new RegExp(`\\$\\s?(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s*(k\\b|thousand\\b)?`, 'i').exec(text)
    const spoken = /(\d+(?:\.\d+)?)\s*dollars?\s*(?:an|per|a)\s*hour/i.exec(text)
    const m = single || spoken
    if (m) {
      const n = amount(m[1], m[2])
      if (n !== null) out.pay_min = out.pay_max = n
    }
  }
  if (out.pay_min === undefined) return out
  out.pay_unit = hourly || out.pay_max < 1000 ? 'hour' : 'year'
  if (/\b1099\b/.test(text)) out.pay_basis = '1099_hourly'
  else if (/\bW-?2\b/i.test(text) && out.pay_unit === 'hour') out.pay_basis = 'w2_hourly'
  else if (/\b(corp[- ]to[- ]corp|C2C)\b/i.test(text)) out.pay_basis = 'c2c'
  else if (/\bcommission[- ]only\b/i.test(text)) out.pay_basis = 'commission_only'
  else if (/\b(OTE|on[- ]target)\b/i.test(text)) out.pay_basis = 'ote'
  else if (/\bbase\b[^.?!]*\bbonus\b/i.test(text)) out.pay_basis = 'base_plus_bonus'
  else if (/\bbase\b/i.test(text)) out.pay_basis = 'base'
  return out
}

function extractWork(text, company) {
  const out = {}
  if (/\bhybrid\b/i.test(text)) out.work_mode = 'hybrid'
  else if (/\b(on-?site|in[- ]office|in the office|in person)\b/i.test(text)) out.work_mode = 'onsite'
  else if (/\b(fully |100% )?remote\b/i.test(text) && !/\bnot (fully )?remote\b/i.test(text)) out.work_mode = 'remote'
  const days = /\b(\d|one|two|three|four|five)\s+days?\s+(?:a|per|each|every)\s+week\b/i.exec(text)
  if (days && out.work_mode !== 'remote') out.office_days_per_week = count(days[1])
  if (out.work_mode && out.work_mode !== 'remote') {
    // "2 days a week in Austin", "on-site in Dallas, Texas", "out of New York".
    // Only in a sentence about where the work happens, so "from Northwind"
    // is not read as a place.
    const about = /\b(hybrid|on-?site|office|in person|based|days? (?:a|per|each|every) week)\b/i
    for (const sentence of text.split(/(?<=[.?!])\s+/)) {
      if (!about.test(sentence)) continue
      const m = /\b(?:in|out of)\s+([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)?)/.exec(sentence)
      if (!m) continue
      const place = m[1]
      if (NOT_PLACES.has(place.split(/[ -]/)[0].toLowerCase())) continue
      if (company && company.toLowerCase().includes(place.toLowerCase())) continue
      out.office_location = place
      break
    }
  }
  return out
}

function extractProcess(text, now) {
  const out = {}
  const rounds = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:interview\s+)?(?:rounds?|interviews|stages)\b/i.exec(text)
  if (rounds) {
    const n = count(rounds[1])
    if (n && n > 0 && n < 16) out.interview_rounds = n
  }
  const decide = /\b(?:decide|decision|decisions|hear back|get back to (?:her|you)|let (?:her|you|Maya) know|make (?:a|the) call|wrap (?:it )?up|close the role)\b[^.?!]*?\b((?:by|on|before|within|in|around|early|mid|end of|the end of|next|this)\b[^.?!]*)/i.exec(text)
  if (decide) {
    const when = decide[1].trim().replace(/[,;:]+$/, '')
    out.decision_when = when
    const date = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(when)
    if (date) {
      const month = MONTHS.indexOf(date[1].toLowerCase())
      const day = Number(date[2])
      const base = new Date(now)
      let year = base.getUTCFullYear()
      // A date that has already passed this year means next year.
      if (Date.UTC(year, month, day) < Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()) - 86400000) year++
      out.decision_date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return out
}

export function extractDetails(text, { now = new Date(), company = null } = {}) {
  const t = String(text || '')
  // An email address is not pay or a place.
  const clean = t.replace(/\S+@\S+/g, ' ').replace(/\bmy email is\b[^.?!]*[.?!]?/gi, ' ')
  return { ...extractPay(clean), ...extractWork(clean, company), ...extractProcess(clean, now) }
}
