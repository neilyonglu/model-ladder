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
// details: true returns labelled 5h/7d windows instead, with null for unknown/expired windows.
export function readCodexUsage(home = process.env.CODEX_HOME ?? join(homedir(), '.codex'), now = Date.now() / 1000, { details = false, resets = false, evidence = false } = {}) {
  const unknown = evidence ? { sampledAt: null, windows: {}, reason: 'No timestamped subscription sample' } : details ? { fiveHour: null, sevenDay: null } : null
  try {
    const file = newest(join(home, 'sessions'))
    if (!file) return unknown
    const lines = readFileSync(file.path, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue
      let limits, event
      try { event = JSON.parse(lines[i]); limits = find(event, 'rate_limits') } catch { continue }
      if (!limits) continue
      if (evidence) return { sampledAt: Date.parse(event.timestamp) || null, source: file.path,
        windows: Object.fromEntries([limits.primary, limits.secondary].filter((w) => w && Number.isFinite(w.window_minutes)).map((w) => [w.window_minutes === 300 ? 'five_hour' : w.window_minutes === 10080 ? 'seven_day' : `${w.window_minutes}_minutes`, { used: w.used_percent, resetsAt: w.resets_at * 1000 }])) }
      const live = [limits.primary, limits.secondary].filter((w) => Number.isFinite(w?.used_percent) && w.resets_at > now)
      if (details) {
        // Only label known window durations; primary/secondary are not guaranteed to be 5h/7d.
        const percent = (minutes) => live.find((w) => w.window_minutes === minutes)?.used_percent ?? null
        return { fiveHour: percent(300), sevenDay: percent(10080), ...(resets ? { fiveHourResetsAt: live.find((w) => w.window_minutes === 300)?.resets_at ?? null, sevenDayResetsAt: live.find((w) => w.window_minutes === 10080)?.resets_at ?? null } : {}) }
      }
      return live.length ? Math.max(...live.map((w) => w.used_percent)) : null
    }
  } catch {}
  return unknown
}
