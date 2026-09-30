#!/usr/bin/env node
// End-to-end test of the real page against a fake AssemblyAI server, in
// headless Chromium with a fake microphone. No API key needed.
//
//   npm run e2e                  all scenarios
//   npm run e2e -- booked        one scenario
//   SHOTS=1 npm run e2e          also save screenshots to tests/e2e/shots/

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import { startFakeServer } from './fake-aai.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB_PORT = 4123
const AAI_PORT = 4124

const EXPECT = {
  booked: (r) => [
    [r.outcome === 'booked', `outcome booked (got ${r.outcome})`],
    [r.receipt?.to === 'jen.park@northwind-analytics.com', 'receipt addressed to the confirmed email'],
    [/\$115,000–\$135,000 base/.test(r.receipt?.text || ''), 'receipt has the confirmed range'],
    [Boolean(r.receipt?.ics), 'receipt has a calendar invite'],
    [r.verdict.level === 'clear', 'scam verdict clear'],
    [r.audit.passed, `audit passed ${JSON.stringify(r.audit.unsupported)}`],
  ],
  scam: (r) => [
    [r.outcome === 'blocked', `outcome blocked (got ${r.outcome})`],
    [r.receipt === null, 'no receipt for a scam'],
    [r.verdict.reasons.some((x) => x.code === 'asks_payment' && x.by === 'rule'), 'payment red flag found by the rules'],
  ],
  declined: (r) => [
    [r.outcome === 'declined', `outcome declined (got ${r.outcome})`],
    [r.receipt?.to === 'mike@talentbridge.com', 'summary goes to the confirmed email'],
    [/isn't a fit/.test(r.receipt?.text || ''), 'summary says it is not a fit'],
    [!r.receipt?.ics, 'no invite for a declined role'],
    [r.audit.passed, `audit passed ${JSON.stringify(r.audit.unsupported)}`],
  ],
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(base)) return undefined
  for (const dir of readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux', 'chrome')
    if (existsSync(path)) return path
  }
  return undefined
}

async function waitForServer(url, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`server did not start: ${url}`)
}

const only = process.argv[2]
const names = only ? [only] : Object.keys(EXPECT) // smoke has its own runner

const web = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(WEB_PORT), FAKE_AAI_TOKEN: '1', RESEND_API_KEY: '', TELEGRAM_BOT_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
let failures = 0
try {
  await waitForServer(`http://localhost:${WEB_PORT}/api/health`)
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  if (process.env.SHOTS) mkdirSync(join(ROOT, 'tests/e2e/shots'), { recursive: true })

  for (const name of names) {
    const fake = startFakeServer({ port: AAI_PORT, scenario: name })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await page.goto(`http://localhost:${WEB_PORT}/?aai_ws=ws://localhost:${AAI_PORT}`)
    await page.click('#call-btn')
    await page.waitForFunction(() => window.__result, null, { timeout: 30000 })
    const result = await page.evaluate(() => window.__result)
    const dom = {
      inbox: await page.textContent('#inbox-body'),
      phone: await page.textContent('#phone-screen'),
      checks: await page.textContent('#checks-list'),
    }
    await page.waitForTimeout(700) // let the phone card finish sliding in
    if (process.env.SHOTS) await page.screenshot({ path: join(ROOT, `tests/e2e/shots/${name}.png`), fullPage: true })

    const checks = [
      ...EXPECT[name](result),
      [fake.log.problems.length === 0, `protocol ok ${JSON.stringify(fake.log.problems)}`],
      [fake.log.ended, 'page sent session.end'],
      [errors.length === 0, `no page errors ${JSON.stringify(errors)}`],
      [dom.phone.includes(result.briefing.title), 'briefing shown on the phone'],
    ]
    console.log(`\n${name}`)
    for (const [ok, label] of checks) {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
      if (!ok) failures++
    }
    await page.close()
    await fake.close()
  }
  await browser.close()
} finally {
  web.kill()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed')
process.exit(failures ? 1 : 0)
