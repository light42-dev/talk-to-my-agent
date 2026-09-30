// Sends the receipt (to the caller) and the briefing (to the candidate).
// Both are optional: with nothing configured, the page shows previews.
//
//   RESEND_API_KEY, RECEIPT_FROM     email via https://resend.com
//   RECEIPT_TO_OVERRIDE              demo: every receipt goes to this inbox
//   RECEIPT_ALLOWED_DOMAINS          or: only send to these domains (comma list)
//   BRIEFING_TO                      email the candidate's briefing here
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   push the briefing to Telegram

import { noteDelivery } from '../public/core/report.js'

const env = (name) => (process.env[name] || '').trim()

async function resend({ to, subject, text, html, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('RECEIPT_FROM'), to: [to], subject, text, html, attachments }),
  })
  if (!res.ok) throw new Error(`email failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

function receiptRecipient(to) {
  const override = env('RECEIPT_TO_OVERRIDE')
  if (override) return { to: override, note: `Demo copy. On a real call this goes to ${to}.` }
  const allowed = env('RECEIPT_ALLOWED_DOMAINS')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  const domain = String(to).split('@')[1]?.toLowerCase()
  if (allowed.length && domain && allowed.includes(domain)) return { to, note: null }
  return null
}

export function deliveryConfig() {
  return {
    email: Boolean(env('RESEND_API_KEY') && env('RECEIPT_FROM')),
    receiptOverride: Boolean(env('RECEIPT_TO_OVERRIDE')),
    telegram: Boolean(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')),
    briefingEmail: Boolean(env('BRIEFING_TO')),
  }
}

export async function deliver({ receipt, briefing }) {
  const status = { receipt: 'preview', receiptTo: receipt?.to || null, briefing: 'preview', errors: [] }
  const config = deliveryConfig()

  if (receipt && config.email) {
    const target = receiptRecipient(receipt.to)
    if (target) {
      try {
        const banner = target.note ? `[${target.note}]\n\n` : ''
        await resend({
          to: target.to,
          subject: receipt.subject,
          text: banner + receipt.text,
          html: (target.note ? `<p style="color:#8a6d00">${target.note}</p>` : '') + receipt.html,
          attachments: receipt.ics
            ? [{ filename: 'call.ics', content: Buffer.from(receipt.ics).toString('base64') }]
            : undefined,
        })
        status.receipt = 'sent'
        status.receiptTo = target.to
      } catch (error) {
        status.errors.push(error.message)
      }
    } else {
      status.receipt = 'preview'
      status.errors.push('receipt not sent: set RECEIPT_TO_OVERRIDE or RECEIPT_ALLOWED_DOMAINS to send real email')
    }
  } else if (!receipt) {
    status.receipt = 'none'
  }

  noteDelivery(briefing, receipt, status)

  if (config.telegram) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text: briefing.text, disable_web_page_preview: true }),
      })
      if (!res.ok) throw new Error(`telegram failed (${res.status})`)
      status.briefing = 'telegram'
    } catch (error) {
      status.errors.push(error.message)
    }
  }
  if (config.email && config.briefingEmail) {
    try {
      await resend({
        to: env('BRIEFING_TO'),
        subject: briefing.title + (briefing.when ? ` — ${briefing.when}` : ''),
        text: briefing.text,
        html: `<pre style="font-family:system-ui,sans-serif;font-size:15px;white-space:pre-wrap">${briefing.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</pre>`,
      })
      if (status.briefing === 'preview') status.briefing = 'email'
    } catch (error) {
      status.errors.push(error.message)
    }
  }
  return status
}
