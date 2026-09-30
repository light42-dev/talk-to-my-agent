// Minimal .env loader: KEY=value per line, # comments. Real environment
// variables win. Shared by the local server, the smoke test and the eval.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function loadEnv(root = ROOT) {
  let text = ''
  try {
    text = readFileSync(join(root, '.env'), 'utf8')
  } catch {
    return false
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return true
}
