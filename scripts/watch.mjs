import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCodexUsage } from './codex-usage.mjs'
import { atomicJson, renderLive } from './codex-live.mjs'
import { DEFAULTS } from './codex-run.mjs'

export function parseArgs(argv) {
  const options = { cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
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
export function configureGuard(root, options) {
  const path = join(root, '.codex', 'model-ladder.json')
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const guard = { ...DEFAULTS.usageGuard, ...config.usageGuard }
  if (options.enabled !== undefined) {
    if (typeof options.enabled !== 'boolean') throw new Error('guard enabled must be boolean')
    guard.enabled = options.enabled
  }
  if (options.threshold !== undefined) {
    if (!Number.isFinite(options.threshold) || options.threshold < 1 || options.threshold > 100) throw new Error('--threshold must be a number between 1 and 100')
    guard.threshold = options.threshold
  }
  if (options.enabled !== undefined || options.threshold !== undefined) atomicJson(path, { ...config, usageGuard: guard })
  return guard
}
export function watch({ cwd = process.cwd(), output = process.stdout } = {}) {
  const draw = () => {
    let state
    try { state = JSON.parse(readFileSync(join(cwd, '.model-ladder', 'live.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const guard = configureGuard(cwd, {})
    const frame = renderLive({ ...state, usage: readCodexUsage(undefined, undefined, { details: true }) }, { width: output.columns ?? 80, guard })
    output.write(`${output.isTTY ? '\x1b[H\x1b[2J' : ''}${frame}\n`)
  }
  draw()
  const timer = setInterval(() => {
    try { draw() } catch (error) { stop(); process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  }, 1000)
  const stop = () => { clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return stop
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node watch.mjs [--cwd <repo-root>] [--guard on|off] [--threshold 1–100]\nSettings are saved before watching. Ctrl-C stops the watcher.\n')
    else { configureGuard(options.cwd, options); watch(options) }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
