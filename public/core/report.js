// What happens after the call: code decides the outcome, writes the receipt
// the caller gets and the briefing the candidate gets. Only facts the caller
// confirmed out loud make it into the receipt.

import { auditClaims } from './audit.js'
import { describePay, formatDate, overallFit } from './facts.js'
import { scamVerdict } from './scam.js'
import { readbackSentence } from './tools.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const confirmed = (state, field) => state.status?.[field] === 'confirmed'

export function workText(work) {
  if (!work?.mode) return null
  if (work.mode === 'remote') return 'fully remote'
  if (work.mode === 'hybrid') {
    const days = Number.isFinite(work.onsiteDays) ? `${work.onsiteDays} day${work.onsiteDays === 1 ? '' : 's'} a week` : 'some days'
    return `hybrid, ${days} in ${work.location || 'the office'}`
  }
  return `on-site in ${work.location || 'the office'}`
}

export function decisionText(d) {
  if (d.decisionDate) return `by ${formatDate(d.decisionDate, { weekday: true })}`
  return d.decisionText || null
}

// Rows shared by the receipt and the briefing.
export function factRows(state) {
  const d = state.details || {}
  const rows = []
  const add = (key, label, value, field) => {
    if (!value) return
    rows.push({ key, label, value, status: confirmed(state, field) ? 'confirmed' : 'heard' })
  }
  const role = [state.caller?.role, state.caller?.company].filter(Boolean).join(' at ')
  add('role', 'Role', role || null, 'company')
  if (d.pay) add('pay', 'Pay', d.pay.declined ? 'range not shared' : describePay(d.pay), 'pay')
  add('work', 'Work', workText(d.work), 'work')
  if (d.rounds !== null && d.rounds !== undefined) {
    add('rounds', 'Process', `${d.rounds} interview round${d.rounds === 1 ? '' : 's'}`, 'rounds')
  }
  add('decision', 'Decision', decisionText(d), 'decision')
  return rows
}

export function decideOutcome(state, verdict, fit) {
  if (verdict.level === 'scam') return 'blocked'
  if (state.booking) return 'booked'
  if (state.detailsConfirmed && !fit.fits) return 'declined'
  if (state.endReason === 'message_taken' || state.endReason === 'wrong_number') return 'message'
  return 'incomplete'
}

// ---- calendar invite ---------------------------------------------------

const icsDate = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c)

export function buildIcs({ candidate, state, now = new Date() }) {
  if (!state.booking) return null
  const company = state.caller?.company || 'the company'
  const role = state.caller?.role ? ` (${state.caller.role})` : ''
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Talk to My Agent//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsDate(state.booking.start)}-${Math.abs(hash(company + candidate.name))}@talk-to-my-agent`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(state.booking.start)}`,
    `DTEND:${icsDate(state.booking.end)}`,
    `SUMMARY:${icsText(`${candidate.name} × ${company}${role}`)}`,
    `DESCRIPTION:${icsText(`First call booked by ${candidate.firstName}'s agent.\n${readbackSentence(state)}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}

function hash(s) {
  let h = 0
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0
  return h
}

// ---- receipt (to the caller) -------------------------------------------

export function buildReceipt({ candidate, state, outcome, fit }) {
  if (outcome === 'blocked') return null
  if (!state.caller?.email || !state.contactConfirmed) return null

  const first = candidate.firstName
  const callerFirst = (state.caller.name || '').split(' ')[0] || 'there'
  const rows = factRows(state).filter((r) => r.status === 'confirmed')
  const role = state.caller.role || 'the role'
  const company = state.caller.company || 'your company'
  const next = state.booking ? `A ${candidate.rules.callLengthMinutes}-minute call with ${first} on ${state.booking.label} (invite attached)` : null

  let subject
  let intro
  if (outcome === 'booked') {
    subject = `Confirmed: ${candidate.name} × ${company}, ${state.booking.label}`
    intro = `Thanks for calling about the ${role} role at ${company}. Here's what you told me, as confirmed on the call:`
  } else if (outcome === 'declined') {
    subject = `Our call about the ${role} role at ${company}`
    intro = `Thanks for thinking of ${first}. Here's what you told me, as confirmed on the call:`
  } else {
    subject = `Summary of our call about the ${role} role at ${company}`
    intro = `Thanks for calling. Here's what you told me, as confirmed on the call:`
  }

  const bullets = rows.map((r) => `${r.label}: ${r.value}`)
  if (next) bullets.push(`Next step: ${next}`)
  const decline =
    outcome === 'declined' && fit.reasons.length
      ? `As I mentioned, it isn't a fit for ${first} right now because ${fit.reasons.join(' and ')}. She'd be glad to talk if that changes.`
      : null
  const noLine = `If you decide not to move forward, a short reply is enough. ${first} would rather know than wait.`
  const footer = `${candidate.name}'s agent, an AI assistant. Anything not listed above wasn't confirmed on the call.`

  const text = [
    `Hi ${callerFirst},`,
    '',
    intro,
    '',
    ...bullets.map((b) => `• ${b}`),
    '',
    ...(decline ? [decline, ''] : []),
    noLine,
    '',
    `— ${footer}`,
  ].join('\n')

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1d1b16;max-width:560px">
<p>Hi ${esc(callerFirst)},</p>
<p>${esc(intro)}</p>
<table style="border-collapse:collapse;margin:8px 0 16px">${bullets
    .map((b) => {
      const [label, ...rest] = b.split(': ')
      return `<tr><td style="padding:4px 16px 4px 0;color:#6b6a66;vertical-align:top">${esc(label)}</td><td style="padding:4px 0">${esc(rest.join(': '))}</td></tr>`
    })
    .join('')}</table>
${decline ? `<p>${esc(decline)}</p>` : ''}
<p style="padding:12px 14px;background:#f5f3eb;border-radius:8px">${esc(noLine)}</p>
<p style="color:#6b6a66;font-size:13px">— ${esc(footer)}</p>
</div>`

  return { to: state.caller.email, subject, text, html, ics: buildIcs({ candidate, state }) }
}

// ---- briefing (to the candidate) ---------------------------------------

export function buildBriefing({ candidate, state, outcome, verdict, fit, audit, receipt }) {
  const company = state.caller?.company || 'Unknown caller'
  const role = state.caller?.role
  const applied = state.application ? `you applied ${formatDate(state.application.appliedOn)}` : 'no application on file'

  const titles = {
    booked: `${company} booked a call with you`,
    declined: `${company}: not a fit, declined politely`,
    blocked: `Blocked a likely job scam`,
    message: `Message from ${company}`,
    incomplete: `${company} called`,
  }
  const card = {
    tone: { booked: 'good', declined: 'neutral', blocked: 'danger', message: 'neutral', incomplete: 'neutral' }[outcome],
    outcome,
    title: titles[outcome],
    when: state.booking?.label || null,
    subtitle: [role, applied].filter(Boolean).join(' · '),
    facts: factRows(state),
    fit: fit.fits ? null : fit.reasons,
    caller: [state.caller?.name, state.caller?.title, state.caller?.email].filter(Boolean).join(' · ') || null,
    scam: verdict.level === 'clear' ? null : verdict,
    questions: state.openQuestions || [],
    receipt: receipt ? `Summary email drafted for ${receipt.to}` : outcome === 'blocked' ? 'No email sent: blocked as a scam' : 'No email sent: no confirmed address',
    audit: audit.passed
      ? `Nothing made up about you (${audit.checked.agentLines} agent lines checked)`
      : `${audit.unsupported.length} possible made-up claim${audit.unsupported.length === 1 ? '' : 's'} about you: please review`,
  }

  const lines = [
    `${card.title}${card.when ? ` — ${card.when}` : ''}`,
    card.subtitle,
    '',
    ...card.facts.map((f) => `${f.status === 'confirmed' ? '✓' : '·'} ${f.label}: ${f.value}`),
    ...(card.fit ? ['', `Not a fit: ${card.fit.join('; ')}`] : []),
    ...(card.scam ? ['', `Scam warning signs: ${card.scam.reasons.map((r) => r.label).join('; ')}`, ...card.scam.reasons.map((r) => `  "${r.evidence}"`)] : []),
    ...(card.questions.length ? ['', `They asked (answer in your own time): ${card.questions.join('; ')}`] : []),
    ...(card.caller ? ['', `Caller: ${card.caller}`] : []),
    '',
    card.receipt,
    card.audit,
  ].filter((l) => l !== undefined)
  card.text = lines.join('\n')
  return card
}

// ---- the whole post-call step -------------------------------------------

export function finalizeCall({ candidate, state, transcript = [] }) {
  const callerLines = transcript.filter((l) => l.who === 'caller')
  const agentFlags = (state.scamFlags || []).filter((f) => f.by !== 'rule')
  const verdict = scamVerdict(callerLines, agentFlags)
  const fit = overallFit(state, candidate.rules)
  const outcome = decideOutcome(state, verdict, fit)
  const audit = auditClaims({ candidate, state, transcript })
  const receipt = buildReceipt({ candidate, state, outcome, fit })
  const briefing = buildBriefing({ candidate, state, outcome, verdict, fit, audit, receipt })
  return { outcome, verdict, fit, audit, receipt, briefing }
}

// Once delivery is known, the briefing says whether the receipt really went.
export function noteDelivery(briefing, receipt, delivery) {
  if (!receipt || !briefing) return briefing
  const line = delivery?.receipt === 'sent' ? `Summary email sent to ${delivery.receiptTo || receipt.to}` : `Summary email drafted for ${receipt.to} (not sent)`
  briefing.text = briefing.text.replace(briefing.receipt, line)
  briefing.receipt = line
  return briefing
}
