import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { roundSpan } from '../hooks/band/remaining.mjs'

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const clean = (text) => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
function cellWidth(text) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return 2
  const code = text.codePointAt(0)
  if (/^[\p{Mark}]+$/u.test(text)) return 0
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
    code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
    code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 ||
    code >= 0x20000 && code <= 0x3fffd) ? 2 : 1
}
export function displayWidth(text) {
  return [...segments.segment(clean(text))].reduce((width, { segment }) => width + cellWidth(segment), 0)
}
export function truncate(text, width) {
  text = clean(text)
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text
  let result = '', used = 0
  for (const { segment } of segments.segment(text)) {
    const size = cellWidth(segment)
    if (used + size > width - 1) break
    result += segment
    used += size
  }
  return result + '…'
}
const pad = (text, width) => {
  const value = truncate(text, width)
  return value.padEnd(value.length + Math.max(0, width - displayWidth(value)))
}
export function visibleAgents(agents = [], now = Date.now()) {
  return agents.filter((agent) => agent.endedAt === null || now - Date.parse(agent.endedAt) < 10000)
}
export function renderLive(state, { width = 80, now = Date.now(), guard = { enabled: true, threshold: 90 } } = {}) {
  const agents = visibleAgents(state?.agents, now)
  const idle = !(state?.agents ?? []).some((agent) => agent.endedAt === null)
  const percent = (value) => Number.isFinite(value) ? `${value}%` : '?'
  const active = agents.filter((a) => a.endedAt === null)
  const dot = active.some((a) => a.phase.startsWith('verify')) ? '🔵 ' : active.some((a) => a.retry) ? '🔴 ' : active.length ? '🟢 ' : ''
  const window = (name, label) => {
    const ms = state?.usage?.[`${name}ResetsAt`] * 1000 - now
    return `${ms > 0 ? roundSpan(ms) + '/' : ''}${label} ${percent(state?.usage?.[name])}`
  }
  const lines = [`▴ ${dot}model-ladder ── ${window('fiveHour', '5h')} · ${window('sevenDay', '7d')}${idle ? ' · idle' : ''}`]
  const modelWidth = Math.min(32, Math.max(12, ...agents.map((a) => displayWidth(`${a.model}/${a.effort}`))))
  lines.push(`${pad('model/effort', modelWidth)}  ${pad('time', 9)}  task`)
  for (const agent of agents) {
    const seconds = Math.max(0, Math.floor(((agent.endedAt ? Date.parse(agent.endedAt) : now) - Date.parse(agent.startedAt)) / 1000))
    const time = `${agent.endedAt ? agent.pass === false ? '✗ ' : '✓ ' : ''}${seconds}s`
    const prefix = `${pad(`${agent.model}/${agent.effort}`, modelWidth)}  ${pad(time, 9)}  `
    lines.push(prefix + truncate(`${agent.phase}: ${agent.task}`, Math.max(0, width - displayWidth(prefix))))
  }
  const withs = Object.entries(state?.skills ?? {}).filter(([, skills]) => skills?.trim()).map(([role, skills]) => `${role} ${skills}`)
  if (withs.length) lines.push(withs.join(' · '))
  lines.push(`[usage guard: ${guard.enabled ? 'on' : 'off'}]${guard.enabled ? `  threshold ${guard.threshold}%` : ''}`)
  return lines.map((line) => truncate(line, width)).join('\n')
}
