#!/usr/bin/env node
// Runs the eval harness (eval/run.mjs) against a fake server that plays both
// sides of three scripted calls, in spoken and typed mode, so the harness is
// tested without an API key.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDuoServer } from './fake-duo.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TOKEN_PORT = 4132
const AAI_PORT = 4133
const IDS = ['booked_northwind', 'scam_fee_telegram', 'lowball_talentbridge']

const tokenServer = http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'fake-token', expires_in_seconds: 120 }))
  })
  .listen(TOKEN_PORT)

let failures = 0
for (const mode of ['audio', 'text']) {
  const fake = startDuoServer({ port: AAI_PORT })
  const out = mkdtempSync(join(tmpdir(), 'ttma-eval-'))
  const child = spawn(process.execPath, ['eval/run.mjs', ...IDS, '--quiet', ...(mode === 'text' ? ['--text'] : [])], {
    cwd: ROOT,
    env: {
      ...process.env,
      ASSEMBLYAI_API_KEY: 'test-key',
      AGENTS_API_BASE: `http://localhost:${TOKEN_PORT}/v1`,
      AGENTS_WS_URL: `ws://localhost:${AAI_PORT}`,
      EVAL_OUT_DIR: out,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const code = await new Promise((resolve) => child.on('exit', resolve))

  const runDir = join(out, 'runs', readdirSync(join(out, 'runs'))[0])
  const runs = Object.fromEntries(IDS.map((id) => [id, JSON.parse(readFileSync(join(runDir, `${id}.json`), 'utf8'))]))
  const results = readFileSync(join(out, 'RESULTS.md'), 'utf8')
  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
  const checks = [
    [code === 0, `harness exited 0 (got ${code})`],
    [fake.log.problems.length === 0, `protocol ok ${JSON.stringify(fake.log.problems)}`],
    [fake.log.calls.length === 3, `three calls placed (got ${fake.log.calls.join(', ')})`],
    ...IDS.map((id) => [runs[id].ok, `${id} passes every check ${JSON.stringify(failed(runs[id]))}`]),
    [runs.scam_fee_telegram.verdict.reasons.some((r) => r.by === 'rule'), 'scam caught by the rules on the caller line'],
    [mode === 'text' || runs.booked_northwind.latencies.length >= 5, 'reply latency measured on spoken turns'],
    [/3 of 3 calls passed every check/.test(results), 'RESULTS.md written with totals'],
  ]
  console.log(`\neval harness, ${mode} mode`)
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!ok) failures++
  }
  if (checks.some(([ok]) => !ok)) console.log(`\n--- harness output ---\n${log}`)
  await fake.close()
  rmSync(out, { recursive: true, force: true })
}
tokenServer.close()
console.log(failures ? `\n${failures} check(s) failed` : '\neval harness checks passed')
process.exit(failures ? 1 : 0)
