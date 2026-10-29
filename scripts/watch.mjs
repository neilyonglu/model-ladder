import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCodexUsage } from './codex-usage.mjs'
import { renderLive } from './codex-live.mjs'
import { DEFAULTS } from './codex-run.mjs'
import { projectPins } from '../hooks/config-layers.mjs'
import { loadLayered, readLayers, userConfigPath, writeUserGuard } from './config.mjs'
import { createInterface } from 'node:readline'
import { writeHandoff } from './codex-handoff.mjs'

export function parseArgs(argv) {
  const options = { cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--handoff') { options.handoff = true; continue }
    if (flag === '--help' || flag === '-h') { options.help = true; continue }
    if (!['--guard', '--threshold', '--cwd'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--guard') {
      if (!['on', 'off'].includes(value)) throw new Error('--guard must be on or off')
      options.enabled = value === 'on'
    }
    if (flag === '--threshold') {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 100) throw new Error('--threshold must be a number between 1 and 100')
      options.threshold = Number(value)
    }
    if (flag === '--cwd') options.cwd = resolve(value)
  }
  return options
}
// The guard in effect for this repository (defaults, ~/.codex/model-ladder.json, .codex/model-ladder.json).
// options.enabled / options.threshold are the person's explicit change: written to their own file, one field
// each, never to the project file. Returns the guard in effect afterwards.
export function configureGuard(root, options) {
  const patch = {}
  if (options.enabled !== undefined) {
    if (typeof options.enabled !== 'boolean') throw new Error('guard enabled must be boolean')
    patch.enabled = options.enabled
  }
  if (options.threshold !== undefined) {
    if (!Number.isFinite(options.threshold) || options.threshold < 1 || options.threshold > 100) throw new Error('--threshold must be a number between 1 and 100')
    patch.threshold = options.threshold
  }
  if (Object.keys(patch).length) writeUserGuard('codex', patch)
  return loadLayered(root, 'codex', { usageGuard: DEFAULTS.usageGuard }).usageGuard
}
// Said when .codex/model-ladder.json pins the field, so the change in the user's file does not apply here.
const pinned = (root, field) => projectPins(readLayers(root, 'codex').project, field)
  ? ` (saved to ${userConfigPath('codex')}, but .codex/model-ladder.json sets usageGuard.${field} for this project and wins)`
  : ''
export function panelCommand(cwd, command) {
  const words = command.trim().split(/\s+/)
  if (words[0] === 'h' && words.length === 1) return `Handoff: ${writeHandoff(cwd)}`
  if (words[0] === 'g' && words.length === 1) {
    const guard = configureGuard(cwd, {})
    configureGuard(cwd, { enabled: !guard.enabled })
    return `Usage guard ${guard.enabled ? 'off' : 'on'}${pinned(cwd, 'enabled')}`
  }
  if (words[0] === 't' && words.length === 2) {
    const options = parseArgs(['--threshold', words[1]])
    configureGuard(cwd, options)
    return `Threshold ${options.threshold}%${pinned(cwd, 'threshold')}`
  }
  throw new Error('Commands: g (toggle guard), t 90 (threshold), h (handoff), q (quit), then Enter')
}
export function watch({ cwd = process.cwd(), output = process.stdout, input = process.stdin } = {}) {
  let message = ''
  let reader

  const draw = () => {
    let state
    try { state = JSON.parse(readFileSync(join(cwd, '.model-ladder', 'live.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const guard = configureGuard(cwd, {})
    const frame = renderLive({ ...state, usage: readCodexUsage(undefined, undefined, { details: true, resets: true }) }, { width: output.columns ?? 80, guard })
    output.write(`${output.isTTY ? '\x1b[H\x1b[2J' : ''}${frame}\n${input.isTTY ? 'g: guard · t 90: threshold · h: handoff · q: quit (Enter to apply)\n' + message + '\n> ' + (reader?.line ?? '') : ''}`)
  }
  draw()
  const timer = setInterval(() => {
    try { draw() } catch (error) { stop(); process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  }, 1000)
  const stop = () => { reader?.close(); reader = undefined; clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  if (input.isTTY) {
    reader = createInterface({ input, output, terminal: true })
    reader.on('line', (line) => {
      if (line.trim() === 'q') return stop()
      try { message = panelCommand(cwd, line) } catch (error) { message = error.message }
      draw()
    })
    reader.on('SIGINT', stop)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return stop
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node watch.mjs [--cwd <repo-root>] [--guard on|off] [--threshold 1–100] [--handoff]\n--guard and --threshold are saved to your own ~/.codex/model-ladder.json (not the project file) before watching. Ctrl-C stops the watcher.\n')
    else if (options.handoff) process.stdout.write(`${writeHandoff(options.cwd)}\n`)
    else { configureGuard(options.cwd, options); watch(options) }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
