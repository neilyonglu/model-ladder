// End-to-end scenarios: run /model-ladder:run headlessly on each planted problem and check the outcome.
// Usage: node tests/e2e/run.mjs [--dry] [scenario ...]    (default: all)
// --dry plants each scenario and shows the pytest result without calling claude.
// Headless runs cannot answer questions, so "asks" scenarios check the question and that nothing ran.
import { rmSync } from 'node:fs'
import { SCENARIOS, lines, observe, prepare, pytest, runClaude } from './scenarios.mjs'

function judge(expect, seen, said) {
  const problems = []
  if (/task (is|was) empty|empty task|no task/i.test(said)) return ['the task never reached the skill']
  if (expect.asks) {
    if (!expect.asks.test(said)) problems.push(`expected a question matching ${expect.asks}`)
    if (seen.history.length) problems.push(`expected a question and no run, got a ${seen.last.status} run`)
    const allowed = expect.dirtyOnly ?? []
    const extra = seen.changed.filter((p) => !allowed.includes(p))
    if (extra.length) problems.push(`files changed without a run: ${extra.join(', ')}`)
    return problems
  }
  if (!seen.last) return ['no history line: the run never finished']
  if (seen.last.status !== expect.status) problems.push(`status ${seen.last.status}, expected ${expect.status}`)
  for (const file of expect.changed ?? []) {
    if (!seen.changed.includes(file)) problems.push(`${file} not changed`)
  }
  if (expect.testsUntouched && seen.changed.some((p) => p.startsWith('tests/'))) problems.push('a test file changed')
  if (expect.changedUnder && !seen.changed.some((p) => p.startsWith(expect.changedUnder))) {
    problems.push(`nothing changed under ${expect.changedUnder}`)
  }
  if (expect.status !== 'VERIFIED' && seen.changed.length) problems.push(`files changed on ${seen.last.status}: ${seen.changed.join(', ')}`)
  return problems
}

const dry = process.argv.includes('--dry')
const names = process.argv.slice(2).filter((a) => a !== '--dry')
const unknown = names.filter((n) => !SCENARIOS[n])
if (unknown.length) {
  console.error(`unknown scenario(s): ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(1)
}
const selected = names.length ? names : Object.keys(SCENARIOS)

if (dry) {
  for (const name of selected) {
    const dir = prepare(SCENARIOS[name])
    const r = pytest(dir)
    console.log(`${name.padEnd(12)} pytest exit ${r.status}  ${lines(r.stdout ?? '').at(-1) ?? lines(r.stderr ?? '').at(-1)}  dirty: ${observe(dir).changed.join(', ') || '-'}`)
    rmSync(dir, { recursive: true, force: true })
  }
  process.exit(0)
}

const rows = []
for (const name of selected) {
  const scenario = SCENARIOS[name]
  const dir = prepare(scenario)
  process.stdout.write(`${name} ... `)
  const out = runClaude(dir, `/model-ladder:run ${scenario.task}`, { plugin: true })
  const seen = observe(dir)
  const problems = judge(scenario.expect, seen, String(out.result ?? ''))
  const cells = seen.last?.attempts?.map((a) => `${a.cell}${a.pass ? '✓' : '✗'}`).join(' ') ?? '-'
  rows.push({ name, ok: !problems.length, status: seen.last?.status ?? 'none', cells, tokens: seen.last?.tokens ?? 0, cost: out.total_cost_usd ?? 0 })
  console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}\n  repo kept at ${dir}\n  claude said: ${String(out.result).slice(0, 1500)}` : 'ok')
  if (!problems.length) rmSync(dir, { recursive: true, force: true })
}

console.log('\nscenario     result  status    attempts                         tokens  list $')
for (const r of rows) {
  console.log(`${r.name.padEnd(12)} ${(r.ok ? 'ok' : 'FAIL').padEnd(7)} ${r.status.padEnd(9)} ${r.cells.padEnd(32)} ${String(r.tokens).padStart(6)}  ${r.cost.toFixed(2)}`)
}
process.exit(rows.every((r) => r.ok) ? 0 : 1)
