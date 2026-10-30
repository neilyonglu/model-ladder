import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const string = { type: 'string' }
const nullable = { type: ['string', 'null'] }
const strings = { type: 'array', items: string }
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
export const SCHEMAS = {
  route: object({ model: string, effort: string, reason: string, goal: string, scope: strings, allowTests: { type: 'boolean' }, readOnly: { type: 'boolean' }, question: nullable, estimatedMinutes: { type: 'integer' }, optimisticMinutes: { type: 'integer' }, pessimisticMinutes: { type: 'integer' } }),
  worker: object({ status: { enum: ['done', 'blocked'] }, summary: string, blockedReason: nullable }),
  verify: object({ pass: { type: 'boolean' }, reason: string, output: string }),
  diagnose: object({ action: { enum: ['raise_effort', 'raise_model', 'stop_environment', 'stop_unclear'] }, model: nullable, effort: nullable, reason: string, hint: string }),
}

export function validate(value, schema, path = 'output') {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid choice`)
  const types = [schema.type].flat().filter(Boolean)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const ok = types.includes(type) || type === 'number' && Number.isInteger(value) && types.includes('integer')
  if (types.length && !ok) throw new Error(`${path}: expected ${types.join('/')}`)
  if (schema.type === 'object') {
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`)
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unexpected property`)
      validate(value[key], schema.properties[key], `${path}.${key}`)
    }
  }
  if (schema.type === 'array') value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`))
  return value
}

// Request this extra decision only when the caller supplies actual context data.
SCHEMAS.directRoute = object({ ...SCHEMAS.route.properties, small: { type: 'boolean' }, smallReason: string })

export class EnvironmentError extends Error {}
const SETUP_FAILURE = /not authenticated|unauthorized|authentication|login required|log in|invalid.*api.?key|401\b|403\b|model.{0,80}(not found|not available|not supported|unsupported|does not exist)|(?:unsupported|not supported).{0,80}(model|reasoning|effort)|(?:reasoning|effort).{0,80}(?:unsupported|not supported)|sandbox|permission denied|access denied/i
const LIMIT_FAILURE = /usage.limit|rate.limit|quota|too many requests|\b429\b/i
// Errors no stronger model can fix. Setup problems (auth, sandbox, model access) win over limit wording.
export function environmentFailure(text) {
  return SETUP_FAILURE.test(text) || LIMIT_FAILURE.test(text)
}
// Codex's own usage, rate or quota limit: code USAGE_LIMIT, so the runner writes HANDOFF.md and nobody retries before the reset.
export function usageLimitFailure(text) {
  return !SETUP_FAILURE.test(text) && LIMIT_FAILURE.test(text)
}

function kill(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }) } catch { child.kill('SIGKILL') }
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
}

export function processRun(command, args, { cwd, input = '', timeoutMs = 600000, signal, shell = false, env: extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', stopped = null
    const failure = (message, code) => Object.assign(new EnvironmentError(message), { code, cwd, stdout, stderr })
    if (signal?.aborted) return reject(failure('Cancelled', 'CANCELLED'))
    const env = { ...process.env, ...extraEnv }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = (code) => { if (!stopped) { stopped = code; kill(child) } }
    const abort = () => stop('CANCELLED')
    signal?.addEventListener('abort', abort, { once: true })
    // Idle limit, not a deadline: any output proves the child is still working and restarts the clock.
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    const tail = (text, limit) => text.slice(-limit).replace(/^[\uDC00-\uDFFF]/, '')
    child.stdout.setEncoding('utf8').on('data', (data) => { timer.refresh(); stdout = tail(stdout + data, 131072) })
    child.stderr.setEncoding('utf8').on('data', (data) => { timer.refresh(); stderr = tail(stderr + data, 16384) })
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure(error.message, error.code)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (stopped) reject(failure(stopped === 'TIMEOUT' ? `Timed out after ${timeoutMs}ms without output` : 'Cancelled', stopped))
      else resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

export async function codexExec({ phase, cell, cwd, run, prompt, sandbox, timeoutMs, signal, executable, schema = SCHEMAS[phase] }) {
  const schemaPath = join(run, `${phase}.schema.json`)
  const outputPath = join(run, `${phase}.output.json`)
  writeFileSync(schemaPath, JSON.stringify(schema))
  rmSync(outputPath, { force: true })
  const args = [...(executable?.prefixArgs ?? []), 'exec', '-m', cell.model, '-c', `model_reasoning_effort=${JSON.stringify(cell.effort)}`,
    '-C', cwd, '--json', '--output-schema', schemaPath, '-o', outputPath, '--sandbox', sandbox, '-']
  let result, events = []
  try {
    result = await processRun(executable?.command ?? process.env.CODEX_BINARY ?? 'codex', args, { cwd, input: `This is one internal model-ladder role. Do not invoke model-ladder skills, workflows or runners recursively; perform only the assigned role.\n\n${prompt}`, timeoutMs, signal, env: { MODEL_LADDER_ROLE: phase, MODEL_LADDER_AUTORUN: '0', MODEL_LADDER_BAND: '0' } })
  } catch (error) {
    result = error
    Object.assign(error, { phase, cwd })
    throw error
  } finally {
    if (result) {
      events = (result.stdout ?? '').split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
      result.usage = events.filter((event) => event.type === 'turn.completed').map((event) => event.usage ?? {})
      const logId = `${phase}-${randomUUID()}`
      writeFileSync(join(run, `${logId}.events.jsonl`), result.stdout ?? '')
      if (result.stderr) writeFileSync(join(run, `${logId}.stderr.txt`), result.stderr)
    }
  }
  const errors = events.filter((event) => event.type === 'error' || event.type === 'turn.failed').map((event) => JSON.stringify(event)).join('\n')
  const errorText = `${result.stderr}\n${errors}`
  if ((result.code !== 0 || errors) && environmentFailure(errorText)) {
    throw Object.assign(new EnvironmentError(errorText.slice(-4000)), { ...result, phase, cwd }, (usageLimitFailure(errors) || usageLimitFailure(errorText)) && { code: 'USAGE_LIMIT' })
  }
  if (result.code !== 0 || errors) throw Object.assign(new Error(`Codex ${phase} failed (${result.code}): ${errorText.slice(-4000)}`), { usage: result.usage })
  let value
  try { value = validate(JSON.parse(readFileSync(outputPath, 'utf8')), schema) }
  catch (error) { throw Object.assign(new Error(`Codex ${phase} returned invalid output: ${error.message}`), { usage: result.usage }) }
  return { value, usage: result.usage }
}
