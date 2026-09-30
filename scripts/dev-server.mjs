#!/usr/bin/env node
// Local server: serves public/ and the same API handlers Vercel runs.
//
//   npm run dev        then open http://localhost:3000

import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'

import { ROOT, loadEnv } from './env.mjs'

const PUBLIC = join(ROOT, 'public')

// .env first: the handlers read their settings when they load.
loadEnv()
const { finalizeHandler, healthHandler, tokenHandler } = await import('../server/handlers.js')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

// Gives Node's response the two helpers Vercel adds: status() and json().
function vercelish(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
    return res
  }
  return res
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const routes = { '/api/token': tokenHandler, '/api/finalize': finalizeHandler, '/api/health': healthHandler }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes[url.pathname]
  if (route) {
    req.body = req.method === 'POST' ? await readBody(req) : undefined
    try {
      await route(req, vercelish(res))
    } catch (error) {
      console.error(error)
      if (!res.headersSent) vercelish(res).status(500).json({ error: String(error.message || error) })
    }
    return
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  if (!path || path.endsWith('/')) path += 'index.html'
  const file = join(PUBLIC, path)
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end()
    return
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
  }
})

let port = Number(process.env.PORT) || 3000
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT && port < 3010) {
    port += 1
    server.listen(port)
    return
  }
  throw err
})
server.on('listening', () => {
  const key = process.env.ASSEMBLYAI_API_KEY ? 'set' : process.env.FAKE_AAI_TOKEN === '1' ? 'fake (tests)' : 'MISSING: add it to .env'
  console.log(`Talk to My Agent: http://localhost:${port}`)
  console.log(`ASSEMBLYAI_API_KEY: ${key}`)
})
server.listen(port)
