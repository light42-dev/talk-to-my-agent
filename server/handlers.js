// The only server code: mint a short-lived AssemblyAI token for the browser,
// and run the post-call step. Used by the Vercel functions in api/ and by
// scripts/dev-server.mjs locally.

import { APPLICATIONS, CANDIDATE } from '../public/core/candidate.js'
import { finalizeCall } from '../public/core/report.js'
import { restoreState } from '../public/core/tools.js'
import { deliver, deliveryConfig } from './deliver.js'

const AAI = process.env.AGENTS_API_BASE || 'https://agents.assemblyai.com/v1'

// Crude per-instance limit so a public demo URL can't burn the key's credits.
const recent = new Map()
function limited(ip) {
  const now = Date.now()
  const hits = (recent.get(ip) || []).filter((t) => now - t < 3600_000)
  hits.push(now)
  recent.set(ip, hits)
  return hits.length > Number(process.env.TOKENS_PER_IP_PER_HOUR || 20)
}

export async function tokenHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (process.env.FAKE_AAI_TOKEN === '1') return res.status(200).json({ token: 'fake-token-for-tests' })
  const key = process.env.ASSEMBLYAI_API_KEY
  if (!key) return res.status(500).json({ error: 'Server is missing ASSEMBLYAI_API_KEY.' })
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim()
  if (limited(ip)) return res.status(429).json({ error: 'Too many calls from this address. Try again in an hour.' })

  try {
    const { status, body } = await mintToken(key)
    if (status < 200 || status > 299) return res.status(502).json({ error: `AssemblyAI token request failed (${status})`, detail: body.slice(0, 300) })
    return res.status(200).json(JSON.parse(body))
  } catch (error) {
    return res.status(502).json({ error: 'Could not reach AssemblyAI.', detail: String(error.message || error) })
  }
}

// A token opens exactly one session; the session is capped at ten minutes.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration
// If the API ever rejects the optional `product` parameter (used by
// AssemblyAI's starter, not in the API reference), retry without it.
// The session cap is always sent (the API's default is three hours).
export async function mintToken(key, { maxSeconds = process.env.MAX_CALL_SECONDS || 600 } = {}) {
  const cap = String(Math.min(10800, Math.max(60, Math.round(Number(maxSeconds) || 600))))
  const attempts = [
    { product: 'voice_agent', expires_in_seconds: '120', max_session_duration_seconds: cap },
    { expires_in_seconds: '120', max_session_duration_seconds: cap },
  ]
  let last = { status: 0, body: '' }
  for (const params of attempts) {
    const url = new URL(`${AAI}/token`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
    last = { status: r.status, body: await r.text() }
    // Only a rejected parameter is worth retrying; a bad key is not.
    if (r.ok || ![400, 422].includes(r.status)) return last
  }
  return last
}

function clip(transcript) {
  if (!Array.isArray(transcript)) return []
  return transcript
    .slice(0, 400)
    .filter((l) => l && (l.who === 'caller' || l.who === 'agent'))
    .map((l) => ({ who: l.who, text: String(l.text || '').slice(0, 2000), at: l.at || null }))
}

export async function finalizeHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' })
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Missing body' })

  // The server trusts its own copy of the candidate, not the browser's.
  const state = restoreState(body.state, CANDIDATE, APPLICATIONS)
  const transcript = clip(body.transcript)
  const result = finalizeCall({ candidate: CANDIDATE, state, transcript })
  const delivery = await deliver(result)
  return res.status(200).json({ ...result, delivery })
}

export async function healthHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    ok: true,
    assemblyai: Boolean(process.env.ASSEMBLYAI_API_KEY) || process.env.FAKE_AAI_TOKEN === '1',
    delivery: deliveryConfig(),
  })
}
