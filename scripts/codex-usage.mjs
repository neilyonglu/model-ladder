import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const find = (value, key) => {
  if (!value || typeof value !== 'object') return undefined
  if (value[key] && typeof value[key] === 'object') return value[key]
  for (const child of Object.values(value)) { const hit = find(child, key); if (hit) return hit }
}
const newest = (dir) => {
  let best
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const hit = entry.isDirectory() ? newest(path) : entry.name.endsWith('.jsonl') ? { path, mtime: statSync(path).mtimeMs } : undefined
    if (hit && (!best || hit.mtime > best.mtime)) best = hit
  }
  return best
}
// Highest used_percent among unexpired windows of the latest Codex session; null = unknown (never blocks).
export function readCodexUsage(home = process.env.CODEX_HOME ?? join(homedir(), '.codex'), now = Date.now() / 1000) {
  try {
    const file = newest(join(home, 'sessions'))
    if (!file) return null
    const lines = readFileSync(file.path, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue
      let limits
      try { limits = find(JSON.parse(lines[i]), 'rate_limits') } catch { continue }
      if (!limits) continue
      const live = [limits.primary, limits.secondary].filter((w) => typeof w?.used_percent === 'number' && w.resets_at > now).map((w) => w.used_percent)
      return live.length ? Math.max(...live) : null
    }
  } catch {}
  return null
}
