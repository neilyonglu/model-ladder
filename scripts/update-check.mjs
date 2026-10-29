// Tells the user when a newer model-ladder is published. Third-party marketplaces do not
// auto-update by default and Claude Code does not announce new versions, so the report does.
// At most one network check a day; any failure is silent. Opt out with MODEL_LADDER_NO_UPDATE_CHECK=1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LATEST_URL = 'https://raw.githubusercontent.com/usio0108/model-ladder/main/.claude-plugin/plugin.json'
const DAY_MS = 24 * 60 * 60 * 1000

export const installedVersion = () =>
  JSON.parse(readFileSync(fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url)), 'utf8')).version

// 1 if a > b, -1 if a < b, 0 if equal. Plain x.y.z; anything else compares as 0.
export function compareVersions(a, b) {
  const parts = (v) => String(v).split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some(Number.isNaN)) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}

async function fetchLatest() {
  const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).version
}

export async function updateNote({
  current = installedVersion(),
  latest = fetchLatest,
  cachePath = join(tmpdir(), 'model-ladder-update-check.json'),
  now = Date.now(),
  env = process.env,
} = {}) {
  if (env.MODEL_LADDER_NO_UPDATE_CHECK) return null
  try {
    let cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null
    if (!cached || now - cached.checkedAt > DAY_MS) {
      cached = { checkedAt: now, latest: await latest() }
      writeFileSync(cachePath, JSON.stringify(cached))
    }
    if (compareVersions(cached.latest, current) <= 0) return null
    return `model-ladder ${cached.latest} is available (you have ${current}). Update: claude plugin update model-ladder@model-ladder`
  } catch {
    return null
  }
}
