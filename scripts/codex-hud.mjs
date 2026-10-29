import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { truncate } from './codex-live.mjs'

const HUD_ROWS = 1

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), args: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { options.args.push(...argv.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--cwd') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--cwd requires a value')
      options.cwd = resolve(value)
      continue
    }
    options.args.push(arg)
  }
  return options
}

export function hudText(state, width = 80) {
  const agents = Array.isArray(state?.agents) ? state.agents.filter((agent) => agent && typeof agent === 'object') : []
  const active = agents.findLast((agent) => agent.endedAt === null)
  const latest = active ?? agents.at(-1)
  const role = latest?.phase ?? 'waiting'
  const model = latest?.model && latest?.effort ? `${latest.model}/${latest.effort}` : '—'
  const status = state?.result?.status ?? (active ? 'RUNNING' : state?.runId ? 'IDLE' : 'WAITING')
  return truncate(` model-ladder | ${role} | ${model} | ${status} `, width)
}

function readLive(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, '.model-ladder', 'live.json'), 'utf8')) }
  catch { return undefined }
}

function terminalSize(output) {
  return { columns: Math.max(1, output.columns || 80), rows: Math.max(HUD_ROWS + 1, output.rows || 24) }
}

export function windowsCommand(command, args, cwd, env = process.env) {
  const directories = isAbsolute(command) || /[\\/]/.test(command) ? [''] : [cwd, ...(env.PATH ?? '').split(';')]
  const extensions = extname(command) ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
  let executable
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory.replace(/^"|"$/g, ''), command + extension)
      try { if (statSync(candidate).isFile()) { executable = candidate; break } } catch {}
    }
    if (executable) break
  }
  if (!executable) throw new Error(`Codex HUD cannot find ${command} on PATH; install Codex CLI or set CODEX_BINARY`)
  if (/\.(cmd|bat)$/i.test(executable)) throw new Error('Codex HUD requires a native executable on Windows; set CODEX_BINARY to codex.exe instead of a .cmd or .bat shim')
  return { command: executable, args }
}

export async function runHud({ cwd = process.cwd(), args = [], input = process.stdin, output = process.stdout, command = process.env.CODEX_BINARY ?? 'codex', pty: injectedPty } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Codex HUD requires an interactive terminal')
  let pty = injectedPty
  if (!pty) try {
    const module = await import('node-pty')
    pty = module.default ?? module
  } catch {
    throw new Error('Codex HUD needs node-pty for Windows ConPTY support; run npm install in the model-ladder directory')
  }
  const size = () => terminalSize(output)
  let dimensions = size()
  if (process.platform === 'win32') ({ command, args } = windowsCommand(command, args, cwd))
  const child = pty.spawn(command, args, {
    name: process.env.TERM ?? 'xterm-256color',
    cols: dimensions.columns,
    rows: dimensions.rows - HUD_ROWS,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
    cwd,
    env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color', MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' },
  })
  const wasRaw = Boolean(input.isRaw)
  let exited = false
  let timer
  let pending = ''
  let outputFailed = false
  const subscriptions = []
  let rejectRun
  const guard = (callback) => (...values) => {
    try { callback(...values) } catch (error) { rejectRun(error) }
  }
  const draw = () => {
    if (pending) return
    const text = hudText(readLive(cwd), Math.max(0, dimensions.columns - 1))
    output.write(`\x1b7\x1b[${dimensions.rows};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b8`)
  }
  const resize = () => {
    output.write(`\x1b7\x1b[${Math.min(dimensions.rows, size().rows)};1H\x1b[2K\x1b8`)
    dimensions = size()
    output.write(`\x1b[1;${dimensions.rows - HUD_ROWS}r`)
    child.resize(dimensions.columns, dimensions.rows - HUD_ROWS)
    draw()
  }
  const decoder = new StringDecoder('utf8')
  const forward = guard((data) => child.write(typeof data === 'string' ? data : decoder.write(data)))
  const stop = guard(() => child.kill())
  const onResize = guard(resize)
  const onInputError = (error) => rejectRun(error)
  const onOutputError = (error) => { outputFailed = true; rejectRun(error) }
  try {
    return await new Promise((resolve, reject) => {
      rejectRun = reject
      subscriptions.push(child.onExit((event) => { exited = true; resolve(event) }))
      subscriptions.push(child.onData(guard((data) => {
        // Do not insert HUD escapes inside a split CSI, OSC or control string.
        const text = pending + data
        const incomplete = /\x1b(?:\[[0-?]*[ -/]*|[ -/]*|[\]PX^_](?:(?!\x1b\\)[^\x07])*)$/.exec(text)
        pending = incomplete?.[0] ?? ''
        // ConPTY reports its smaller viewport as an xterm window resize request.
        const complete = pending ? text.slice(0, -pending.length) : text
        output.write(complete.replace(/\x1b\[8;\d+;\d+t/g, ''))
        draw()
      })))
      output.on('resize', onResize)
      output.on('error', onOutputError)
      input.on('data', forward)
      input.on('error', onInputError)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
      input.setRawMode(true)
      input.resume()
      output.write(`\x1b[1;${dimensions.rows - HUD_ROWS}r`)
      draw()
      timer = setInterval(guard(draw), 500)
    })
  } finally {
    if (timer) clearInterval(timer)
    output.off('resize', onResize)
    output.off('error', onOutputError)
    input.off('data', forward)
    input.off('error', onInputError)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop)
    for (const subscription of subscriptions) subscription.dispose()
    try { if (!exited) child.kill() } finally {
      input.pause()
      try { input.setRawMode(wasRaw) } finally {
        if (!outputFailed) output.write(`\x1b[r\x1b[${dimensions.rows};1H\x1b[2K`)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node scripts/codex-hud.mjs [--cwd <repo-root>] [-- <Codex arguments>]\nStarts a new Codex CLI session inside a one-line model-ladder HUD. It cannot attach to an already-running Codex CLI.\n')
    else {
      const { exitCode } = await runHud(options)
      // Windows PTY worker threads can remain referenced after their child exits.
      process.stdout.write('', () => process.exit(exitCode))
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
