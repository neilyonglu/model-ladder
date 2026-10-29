import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
const pty = { spawn() { throw new Error('spawn not mocked') } }
import { hudText, parseArgs, runHud, windowsCommand } from '../../scripts/codex-hud.mjs'

test('HUD reports the active role, model/effort and state from live.json', () => {
  const state = { runId: 'demo', agents: [
    { phase: 'router', model: 'gpt-router', effort: 'low', endedAt: '2026-10-29T00:00:00Z' },
    { phase: 'worker', model: 'gpt-worker', effort: 'medium', endedAt: null },
  ] }
  assert.equal(hudText(state), ' model-ladder | worker | gpt-worker/medium | RUNNING ')
  assert.match(hudText({ result: { status: 'VERIFIED' } }), /waiting \| — \| VERIFIED/)
  assert.equal(hudText(state, 20), ' model-ladder | wor…')
  assert.deepEqual(parseArgs(['--cwd', 'fixture', '--', 'resume', '--last']), { cwd: resolve('fixture'), args: ['resume', '--last'] })
  assert.throws(() => parseArgs(['--cwd']), /requires/)
  for (const agents of [null, {}, [null, 'broken']]) assert.match(hudText({ agents }), /WAITING/)
})

test('Windows PATH preserves native arguments and rejects command shims', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-path-'))
  try {
    mkdirSync(join(cwd, 'bin with spaces'))
    writeFileSync(join(cwd, 'bin with spaces/codex.EXE'), '')
    const env = { PATH: join(cwd, 'missing') + ';' + join(cwd, 'bin with spaces'), PATHEXT: '.EXE;.CMD', SystemRoot: 'C:/Windows' }
    assert.deepEqual(windowsCommand('codex', ['resume', '--last'], cwd, env), { command: join(cwd, 'bin with spaces/codex.EXE'), args: ['resume', '--last'] })
    assert.throws(() => windowsCommand('absent', [], cwd, env), /cannot find/)
    const args = ['a&echo.HUD_INJECTED', "a'b & $()", '中文 空白', '"quoted"']
    assert.deepEqual(windowsCommand('codex', args, cwd, env).args, args)
    for (const extension of ['CMD', 'BAT']) {
      writeFileSync(join(cwd, `codex.${extension}`), '@echo HUD_INJECTED')
      assert.throws(() => windowsCommand(`codex.${extension}`, args, cwd, env), /native executable/)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('HUD restores raw mode, pauses input and cleans up after exit and callback failures', async (t) => {
  for (const failure of [null, 'draw', 'resize', 'input', 'setup', 'input stream', 'output stream']) {
    await t.test(failure ?? 'normal exit', async (t) => {
      const input = Object.assign(new EventEmitter(), {
        isTTY: true, isRaw: failure === null, paused: true,
        setRawMode(value) { this.isRaw = value },
        resume() { this.paused = false; if (failure === 'setup') throw new Error('setup failure') },
        pause() { this.paused = true },
      })
      let outputText = '', inputText = '', throwWrite = false, killed = 0, onData, onExit, disposed = 0
      const output = Object.assign(new EventEmitter(), {
        isTTY: true, columns: 60, rows: 8,
        write(data) { if (throwWrite) { throwWrite = false; throw new Error('draw failure') } outputText += data },
      })
      const child = {
        onData(callback) { onData = callback; return { dispose() { disposed++ } } },
        onExit(callback) { onExit = callback; return { dispose() { disposed++ } } },
        kill() { killed++ },
        write(text) { if (failure === 'input') throw new Error('input failure'); inputText += text },
        resize(cols, rows) { assert.equal(cols, 50); assert.equal(rows, 5); if (failure === 'resize') throw new Error('resize failure') },
      }
      t.mock.method(pty, 'spawn', (command, args, options) => {
        assert.equal(command.toLowerCase(), process.execPath.toLowerCase())
        assert.equal(options.env.MODEL_LADDER_HUD, '1')
        assert.equal(options.env.MODEL_LADDER_BAND, '0')
        return child
      })
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))
      const running = runHud({ command: process.execPath, input, output, pty })
      const settled = failure ? assert.rejects(running, new RegExp(`${failure} failure`)) : running
      // runHud imports the PTY asynchronously; wait until setup has completed.
      await new Promise((resolve) => setImmediate(resolve))
      if (failure === 'draw') { throwWrite = true; onData('hello') }
      else if (failure === 'resize') { output.columns = 50; output.rows = 6; output.emit('resize') }
      else if (failure === 'input') input.emit('data', Buffer.from('hello'))
      else if (failure === 'input stream') input.emit('error', new Error('input stream failure'))
      else if (failure === 'output stream') output.emit('error', new Error('output stream failure'))
      else if (!failure) {
        input.emit('data', Buffer.from([0xe4, 0xb8]))
        input.emit('data', Buffer.from([0xad]))
        assert.equal(inputText, '\u4e2d')
        onData('\x1b[')
        const previous = outputText
        onData('2Jprompt')
        assert.match(outputText.slice(previous.length), /^\x1b\[2Jprompt\x1b7/)
        onData('\x1b]0;title')
        onData('\x1b\\')
        assert.match(outputText, /\x1b\]0;title\x1b\\\x1b7/)
        onData('\x1b[8;5;40t')
        assert.doesNotMatch(outputText, /\x1b\[8;5;40t/)
        output.columns = 50; output.rows = 6; output.emit('resize')
        onExit({ exitCode: 7 })
        assert.equal((await running).exitCode, 7)
      }
      await settled
      assert.equal(input.isRaw, failure === null)
      assert.equal(input.paused, true)
      assert.equal(input.listenerCount('data'), 0)
      assert.equal(output.listenerCount('resize'), 0)
      assert.equal(input.listenerCount('error'), 0)
      assert.equal(output.listenerCount('error'), 0)
      assert.equal(killed, failure ? 1 : 0)
      assert.equal(disposed, 2)
      assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)), signals)
      if (failure !== 'output stream') assert.match(outputText, /\x1b\[r/)
    })
  }
})

function harness(t, { cwd, command = process.execPath } = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: true, paused: true,
    setRawMode(value) { this.isRaw = value },
    resume() { this.paused = false },
    pause() { this.paused = true },
  })
  const writes = []
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, rows: 8, write(data) { writes.push(data) } })
  const calls = { kill: 0, resize: [], spawn: undefined }
  let exitCallback, dataCallback
  const child = {
    onData(cb) { dataCallback = cb; return { dispose() {} } },
    onExit(cb) { exitCallback = cb; return { dispose() {} } },
    kill() { calls.kill++; exitCallback?.({ exitCode: 130 }) },
    write() {},
    resize(cols, rows) { calls.resize.push([cols, rows]) },
  }
  t.mock.method(pty, 'spawn', (spawnCommand, args, options) => { calls.spawn = { command: spawnCommand, args, options }; return child })
  const intervals = new Set()
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  globalThis.setInterval = (...a) => { const id = realSet(...a); intervals.add(id); return id }
  globalThis.clearInterval = (id) => { intervals.delete(id); realClear(id) }
  t.after(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const id of intervals) realClear(id) })
  const start = async () => {
    const running = runHud({ cwd, command, input, output, pty })
    await new Promise((resolve) => setImmediate(resolve))
    return { running }
  }
  return { input, output, writes, calls, intervals, child, start, onData: (d) => dataCallback(d), exit: (e) => exitCallback(e) }
}

test('spawn passes useConptyDll on Windows only', async (t) => {
  const h = harness(t)
  const { running } = await h.start()
  h.exit({ exitCode: 0 })
  await running
  if (process.platform === 'win32') assert.equal(h.calls.spawn.options.useConptyDll, true)
  else assert.equal(h.calls.spawn.options.useConptyDll, undefined)
})

test('CODEX_BINARY overrides the default codex command', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-hud-bin-'))
  const saved = process.env.CODEX_BINARY
  try {
    const exe = join(dir, 'custom-codex.exe')
    writeFileSync(exe, '')
    process.env.CODEX_BINARY = exe
    const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, resume() {}, pause() {} })
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, rows: 8, write() {} })
    let exitCallback, spawned
    t.mock.method(pty, 'spawn', (command) => {
      spawned = command
      return { onData: () => ({ dispose() {} }), onExit(cb) { exitCallback = cb; return { dispose() {} } }, kill() {}, write() {}, resize() {} }
    })
    const running = runHud({ cwd: dir, input, output, pty })
    await new Promise((resolve) => setImmediate(resolve))
    exitCallback({ exitCode: 0 })
    await running
    assert.equal(spawned.toLowerCase(), exe.toLowerCase())
  } finally {
    if (saved === undefined) delete process.env.CODEX_BINARY; else process.env.CODEX_BINARY = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('windowsCommand honors an absolute CODEX_BINARY path without searching PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-hud-abs-'))
  try {
    const exe = join(dir, 'my-codex.exe')
    writeFileSync(exe, '')
    assert.deepEqual(windowsCommand(exe, ['x'], dir, { PATH: '' }), { command: exe, args: ['x'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SIGINT kills the child and leaves no interval or raw mode behind', async (t) => {
  const h = harness(t)
  const { running } = await h.start()
  assert.equal(h.intervals.size, 1)
  assert.equal(h.input.paused, false)
  process.emit('SIGINT')
  assert.equal((await running).exitCode, 130)
  assert.equal(h.calls.kill >= 1, true)
  assert.equal(h.intervals.size, 0)
  assert.equal(h.input.paused, true)
  assert.equal(h.input.isRaw, true)
})

test('missing or corrupt live.json shows the waiting state and keeps redrawing', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-live-'))
  try {
    const h = harness(t, { cwd })
    const { running } = await h.start()
    assert.match(h.writes.join(''), /WAITING/)
    mkdirSync(join(cwd, '.model-ladder'))
    writeFileSync(join(cwd, '.model-ladder', 'live.json'), '{ not json')
    const before = h.writes.length
    h.onData('child output')
    assert.equal(h.writes.length > before, true)
    assert.match(h.writes.slice(before).join(''), /WAITING/)
    writeFileSync(join(cwd, '.model-ladder', 'live.json'), JSON.stringify({ runId: 'r', agents: [{ phase: 'worker', model: 'm', effort: 'low', endedAt: null }] }))
    h.onData('more')
    assert.match(h.writes.join(''), /worker \| m\/low \| RUNNING/)
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('resize shrinks the pty by the HUD row and redraws the HUD without clobbering output', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-resize-'))
  try {
    const h = harness(t, { cwd })
    const { running } = await h.start()
    assert.deepEqual([h.calls.spawn.options.cols, h.calls.spawn.options.rows], [60, 7])
    h.writes.length = 0
    h.output.columns = 40; h.output.rows = 12
    h.output.emit('resize')
    assert.deepEqual(h.calls.resize, [[40, 11]])
    const text = h.writes.join('')
    assert.match(text, /\x1b\[1;11r/)
    assert.match(text, /\x1b7\x1b\[12;1H\x1b\[2K\x1b\[7m model-ladder/)
    assert.ok(text.indexOf('\x1b[1;11r') < text.indexOf('\x1b[12;1H\x1b[2K\x1b[7m'))
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
