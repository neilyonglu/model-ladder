import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const string = { type: 'string' }
const nullable = { type: ['string', 'null'] }
const strings = { type: 'array', items: string }
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
export const SCHEMAS = {
  route: object({ model: string, effort: string, reason: string, goal: string, scope: strings, allowTests: { type: 'boolean' }, readOnly: { type: 'boolean' }, question: nullable }),
  worker: object({ status: { enum: ['done', 'blocked'] }, summary: string, blockedReason: nullable }),
  verify: object({ pass: { type: 'boolean' }, reason: string, output: string }),
  diagnose: object({ action: { enum: ['raise_effort', 'raise_model', 'stop_environment', 'stop_unclear'] }, model: nullable, effort: nullable, reason: string, hint: string }),
}

export function validate(value, schema, path = 'output') {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid choice`)
  const types = [schema.type].flat().filter(Boolean)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (types.length && !types.includes(type)) throw new Error(`${path}: expected ${types.join('/')}`)
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

export class EnvironmentError extends Error {}
export function environmentFailure(text) {
  return /not authenticated|unauthorized|authentication|login required|log in|invalid.*api.?key|401\b|403\b|model.{0,80}(not found|not available|not supported|unsupported|does not exist)|(?:unsupported|not supported).{0,80}(model|reasoning|effort)|(?:reasoning|effort).{0,80}(?:unsupported|not supported)|sandbox|permission denied|access denied|quota|rate.limit|usage.limit/i.test(text)
}

function kill(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
}

export function processRun(command, args, { cwd, input = '', timeoutMs = 600000, signal, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EnvironmentError('Cancelled'))
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', stopped = null
    const stop = (reason) => { stopped = reason; kill(child) }
    const abort = () => stop('Cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('Timed out'), timeoutMs)
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-131072) })
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16384) })
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new EnvironmentError(error.message)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (stopped) reject(new EnvironmentError(stopped))
      else resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

export async function codexExec({ phase, cell, cwd, run, prompt, sandbox, timeoutMs, signal, executable }) {
  const schemaPath = join(run, `${phase}.schema.json`)
  const outputPath = join(run, `${phase}.output.json`)
  writeFileSync(schemaPath, JSON.stringify(SCHEMAS[phase]))
  rmSync(outputPath, { force: true })
  const args = [...(executable?.prefixArgs ?? []), 'exec', '-m', cell.model, '-c', `model_reasoning_effort=${JSON.stringify(cell.effort)}`,
    '-C', cwd, '--json', '--output-schema', schemaPath, '-o', outputPath, '--ephemeral', '--sandbox', sandbox, '-']
  const result = await processRun(executable?.command ?? process.env.CODEX_BINARY ?? 'codex', args, { cwd, input: `This is one internal model-ladder role. Do not invoke model-ladder skills, workflows or runners recursively; perform only the assigned role.\n\n${prompt}`, timeoutMs, signal })
  writeFileSync(join(run, `${phase}-${randomUUID()}.events.jsonl`), result.stdout)
  if (result.stderr) writeFileSync(join(run, `${phase}-${randomUUID()}.stderr.txt`), result.stderr)
  const events = result.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  const errors = events.filter((event) => event.type === 'error' || event.type === 'turn.failed').map((event) => JSON.stringify(event)).join('\n')
  const errorText = `${result.stderr}\n${errors}`
  if ((result.code !== 0 || errors) && environmentFailure(errorText)) throw new EnvironmentError(errorText.slice(-4000))
  if (result.code !== 0 || errors) throw new Error(`Codex ${phase} failed (${result.code}): ${errorText.slice(-4000)}`)
  let value
  try { value = validate(JSON.parse(readFileSync(outputPath, 'utf8')), SCHEMAS[phase]) }
  catch (error) { throw new Error(`Codex ${phase} returned invalid output: ${error.message}`) }
  const usage = events.filter((event) => event.type === 'turn.completed').map((event) => event.usage ?? {})
  return { value, usage }
}