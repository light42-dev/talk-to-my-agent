#!/usr/bin/env node
// Runs scripts/smoke.mjs against the fake AssemblyAI server and a fake token
// endpoint, so the smoke test itself is tested without an API key.

import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { startFakeServer } from './fake-aai.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TOKEN_PORT = 4130
const AAI_PORT = 4131

const tokenServer = http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const ok = url.pathname === '/v1/token' && req.headers.authorization === 'Bearer test-key' && url.searchParams.get('expires_in_seconds')
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ok ? { token: 'fake-token', expires_in_seconds: 120 } : { error: 'bad request' }))
  })
  .listen(TOKEN_PORT)
const fake = startFakeServer({ port: AAI_PORT, scenario: 'smoke' })

const child = spawn(process.execPath, ['scripts/smoke.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ASSEMBLYAI_API_KEY: 'test-key',
    AGENTS_API_BASE: `http://localhost:${TOKEN_PORT}/v1`,
    AGENTS_WS_URL: `ws://localhost:${AAI_PORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
const code = await new Promise((resolve) => child.on('exit', resolve))

const checks = [
  [code === 0, `smoke script exited 0 (got ${code})`],
  [fake.log.problems.length === 0, `protocol ok ${JSON.stringify(fake.log.problems)}`],
  [fake.log.ended, 'smoke script sent session.end'],
  [fake.log.toolResults.length === 2, `two tool results returned (got ${fake.log.toolResults.length})`],
]
console.log('\nsmoke')
let failures = 0
for (const [ok, label] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
if (failures) console.log(`\n--- smoke output ---\n${out}`)
tokenServer.close()
await fake.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nsmoke test checks passed')
process.exit(failures ? 1 : 0)
