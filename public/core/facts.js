// Deterministic checks. The model reports what it heard; this file decides
// whether it is valid and whether it fits the candidate's rules.

export const PAY_UNITS = ['year', 'hour']
export const PAY_BASES = ['base', 'base_plus_bonus', 'ote', 'w2_hourly', '1099_hourly', 'c2c', 'commission_only']
export const WORK_MODES = ['remote', 'hybrid', 'onsite']

// ---- money -------------------------------------------------------------

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).toLowerCase().replace(/[,$\s]/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (!match) return null
  const n = Number(match[1])
  if (match[2] === 'k') return n * 1000
  if (match[2] === 'm') return n * 1_000_000
  return n
}

// "one fifteen" style answers often arrive as 115 when the caller meant
// thousands. An annual figure under 1,000 is read as thousands.
export function normalizePay(min, max, unit) {
  let lo = toNumber(min)
  let hi = toNumber(max)
  if (unit === 'year') {
    if (lo !== null && lo > 0 && lo < 1000) lo *= 1000
    if (hi !== null && hi > 0 && hi < 1000) hi *= 1000
  }
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo]
  return { min: lo, max: hi }
}

export function formatMoney(n, unit) {
  if (n === null || n === undefined) return '?'
  if (unit === 'hour') return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}/hr`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function describePay(pay) {
  if (!pay || (pay.min === null && pay.max === null)) {
    return pay?.declined ? 'not shared' : 'not captured'
  }
  const unit = pay.unit || 'year'
  const range =
    pay.min !== null && pay.max !== null && pay.min !== pay.max
      ? `${formatMoney(pay.min, unit)}–${formatMoney(pay.max, unit)}`
      : formatMoney(pay.max ?? pay.min, unit)
  const basis = {
    base: 'base',
    base_plus_bonus: 'base plus bonus',
    ote: 'on-target earnings',
    w2_hourly: 'W-2',
    '1099_hourly': '1099',
    c2c: 'corp-to-corp',
    commission_only: 'commission only',
  }[pay.basis]
  return basis ? `${range} ${basis}` : range
}

// ---- contact -----------------------------------------------------------

export function normalizeEmail(value) {
  if (!value) return null
  let text = String(value).trim().toLowerCase()
  // Spoken forms that sometimes survive transcription: "j, e, n", "J-E-N",
  // "all one word", "at", "dot", "dash". An address that already has an @
  // is only stripped of spaces.
  if (!text.includes('@')) {
    text = text
      .replace(/,/g, ' ')
      .replace(/\b(all )?(in )?one word\b/g, ' ')
      .replace(/\b[a-z](?:-[a-z])+\b/g, (letters) => letters.replace(/-/g, ''))
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+dash\s+/g, '-')
      .replace(/\s+underscore\s+/g, '_')
  }
  return text.replace(/\s+/g, '')
}

export function isValidEmail(value) {
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(value || '')
}

// "j-e-n dot p-a-r-k at northwind analytics dot com": how the agent should
// read an address back so the caller can catch a wrong letter.
export function spellEmail(email) {
  if (!email) return ''
  const [local, domain] = email.split('@')
  const spell = (part) =>
    part
      .split('.')
      .map((chunk) => (chunk.length <= 4 || /\d/.test(chunk) ? chunk.split('').join(' ') : chunk))
      .join(' dot ')
  return `${spell(local)} at ${domain.split('.').join(' dot ')}`
}

export function normalizePhone(value) {
  if (!value) return null
  const digits = String(value).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return null
}

// ---- dates -------------------------------------------------------------

export function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value))
}

export function formatDate(iso, { weekday = false } = {}) {
  if (!isIsoDate(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d, 12))
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    ...(weekday ? { weekday: 'long' } : {}),
  })
}

// ---- time zones --------------------------------------------------------

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  }
}

// Wall-clock time in a zone to a real instant, correct across DST changes.
export function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute)
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(guess), timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc
  }
  return new Date(guess)
}

export function formatSlot(date, timeZone, zoneLabel) {
  const day = date.toLocaleDateString('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' })
  const time = date.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
  return `${day} at ${time} ${zoneLabel}`
}

// The next open call slots, starting the next business day.
export function openSlots(candidate, now = new Date(), count = 3) {
  const tz = candidate.timezone
  const slots = []
  let cursor = zoneParts(now, tz)
  let dayOffset = 1
  while (slots.length < count && dayOffset < 14) {
    const base = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + dayOffset, 12))
    const weekday = base.getUTCDay()
    dayOffset++
    if (weekday === 0 || weekday === 6) continue
    for (const w of candidate.callWindows) {
      if (slots.length >= count) break
      const start = zonedTimeToUtc(
        { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour: w.hour, minute: w.minute },
        tz
      )
      slots.push({
        id: `slot_${slots.length + 1}`,
        start: start.toISOString(),
        end: new Date(start.getTime() + candidate.rules.callLengthMinutes * 60000).toISOString(),
        label: formatSlot(start, tz, candidate.timezoneLabel),
      })
    }
  }
  return slots
}

// ---- fit against the candidate's rules ---------------------------------

export function payFit(pay, rules) {
  if (!pay || (pay.min === null && pay.max === null)) {
    return { status: pay?.declined ? 'declined' : 'unknown' }
  }
  if (pay.basis === 'commission_only') {
    return { status: 'dealbreaker', reason: 'commission-only pay' }
  }
  const hourly = pay.unit === 'hour'
  const floor = hourly ? rules.hourlyFloor : rules.baseFloorAnnual
  const top = pay.max ?? pay.min
  const bottom = pay.min ?? pay.max
  const floorText = hourly ? `${formatMoney(floor, 'hour')}` : `${formatMoney(floor, 'year')} base`
  if (top < floor) {
    return { status: 'below_floor', floor, reason: `the top of the range is below her ${floorText} floor` }
  }
  if (bottom >= floor) return { status: 'meets_floor', floor }
  return { status: 'top_meets_floor', floor, reason: `only the top of the range meets her ${floorText} floor` }
}

export function workFit(work, rules) {
  if (!work || !work.mode) return { status: 'unknown' }
  const place = (work.location || '').toLowerCase()
  const commutable = !place || rules.commutableCities.some((city) => place.includes(city))
  if (work.mode === 'remote') return { status: 'ok' }
  if (work.mode === 'onsite' && !rules.workModes.includes('onsite')) {
    return { status: 'dealbreaker', reason: 'she is not looking for fully on-site roles' }
  }
  if (!commutable) {
    return { status: 'dealbreaker', reason: `it would mean relocating to ${work.location}` }
  }
  const days = Number(work.onsiteDays)
  if (work.mode === 'hybrid' && Number.isFinite(days) && days > rules.maxOnsiteDaysPerWeek) {
    return {
      status: 'dealbreaker',
      reason: `${days} office days a week is more than her limit of ${rules.maxOnsiteDaysPerWeek}`,
    }
  }
  return { status: 'ok' }
}

export function overallFit(state, rules) {
  const pay = payFit(state.details.pay, rules)
  const work = workFit(state.details.work, rules)
  const blockers = [pay, work].filter((f) => f.status === 'below_floor' || f.status === 'dealbreaker')
  return {
    pay,
    work,
    fits: blockers.length === 0,
    reasons: blockers.map((f) => f.reason),
  }
}
