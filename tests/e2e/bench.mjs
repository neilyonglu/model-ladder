// Benchmark: the same tasks under three strategies, judged the same way.
// Usage: node tests/e2e/bench.mjs [--fresh | --redo <strategy>]
// A task counts as solved when `uv run pytest` passes afterwards and existing tests are untouched
// (add-tests must instead add tests for restock). Results go to tests/e2e/bench-results.json;
// finished pairs are skipped on the next run unless --fresh, so an interrupted run resumes.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, git, observe, prepare, pytest, runClaude } from './scenarios.mjs'

// Hardest first: if the quota runs out midway, the most telling pairs are already done.
const TASKS = ['shipping', 'coupons', 'cart', 'two-files', 'cheat-bait', 'add-tests', 'typo']
const STRATEGIES = {
  'model-ladder': (scenario) => ({ prompt: `/model-ladder:run ${scenario.task}`, plugin: true }),
  'sonnet/high': (scenario) => ({ prompt: plainPrompt(scenario), model: 'sonnet', effort: 'high' }),
  'opus/xhigh': (scenario) => ({ prompt: plainPrompt(scenario), model: 'opus', effort: 'xhigh' }),
}
const RESULTS = fileURLToPath(new URL('./bench-results.json', import.meta.url))

function plainPrompt(scenario) {
  const tests = scenario.allowTests ? '' : ' Do not modify existing tests.'
  return `${scenario.task}\n\nWork in this repository.${tests} When you are done, run \`uv run pytest -q\` to check.`
}

function solved(scenario, dir) {
  if (pytest(dir).status !== 0) return { ok: false, why: 'pytest fails' }
  const testChanges = observe(dir).changed.filter((p) => p.startsWith('tests/'))
  if (scenario.allowTests) {
    const mentions = testChanges.some((p) => existsSync(`${dir}/${p}`) && readFileSync(`${dir}/${p}`, 'utf8').includes('restock'))
    return mentions ? { ok: true } : { ok: false, why: 'no restock tests added' }
  }
  return testChanges.length ? { ok: false, why: `changed ${testChanges.join(', ')}` } : { ok: true }
}

// An API error or exhausted quota says nothing about the strategy. Recording it as a failure
// would also mark the pair done, so stop instead and let the next run resume here.
function infraError(out, ladder) {
  const said = String(out.result ?? '')
  if (said.startsWith('could not parse claude output')) return said.slice(0, 200)
  if (out.api_error_status) return `API error ${out.api_error_status}`
  if (/usage limit|rate limit|hit your limit|quota|overloaded/i.test(said)) return said.slice(0, 200)
  if (ladder?.attempts?.some((a) => /died before reporting/.test(a.reason ?? ''))) return 'a ladder agent died (likely quota or API error)'
  return null
}

// --redo <strategy> drops that strategy's rows and runs it again, keeping the others.
const redo = process.argv.includes('--redo') ? process.argv[process.argv.indexOf('--redo') + 1] : null
const results = (!process.argv.includes('--fresh') && existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : [])
  .filter((r) => r.strategy !== redo)
const done = new Set(results.map((r) => `${r.task}|${r.strategy}`))

for (const task of TASKS) {
  for (const [strategy, make] of Object.entries(STRATEGIES)) {
    if (done.has(`${task}|${strategy}`)) continue
    const scenario = SCENARIOS[task]
    const dir = prepare(scenario)
    process.stdout.write(`${task} / ${strategy} ... `)
    const { prompt, ...opts } = make(scenario)
    const out = runClaude(dir, prompt, opts)
    const ladder = observe(dir).last
    const infra = infraError(out, ladder)
    if (infra) {
      console.log(`stopped: ${infra}\n  Nothing recorded for this pair. Rerun the same command later to resume.\n  repo kept at ${dir}`)
      process.exit(2)
    }
    const verdict = solved(scenario, dir)
    results.push({
      task, strategy, solved: verdict.ok, why: verdict.why ?? null,
      cost: out.total_cost_usd ?? null, outputTokens: out.outputTokens, seconds: Math.round(out.seconds),
      attempts: ladder?.attempts?.map((a) => `${a.cell}${a.pass ? '+' : '-'}`) ?? null,
      head: git(dir, 'rev-parse', '--short', 'HEAD'),
    })
    writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`)
    console.log(`${verdict.ok ? 'solved' : `FAILED (${verdict.why})`}  $${(out.total_cost_usd ?? 0).toFixed(2)}  ${Math.round(out.seconds)}s`)
    if (verdict.ok) rmSync(dir, { recursive: true, force: true })
    else console.log(`  repo kept at ${dir}`)
  }
}

console.log('\ntask         strategy       solved  list $   out tok   secs  ladder attempts')
for (const r of results) {
  console.log(`${r.task.padEnd(12)} ${r.strategy.padEnd(14)} ${(r.solved ? 'yes' : 'no').padEnd(7)} ${(r.cost ?? 0).toFixed(2).padStart(6)}  ${String(r.outputTokens).padStart(8)}  ${String(r.seconds).padStart(5)}  ${r.attempts?.join(' ') ?? ''}`)
}
console.log('\nstrategy       solved  total $  $ per solved  out tok  secs')
for (const strategy of Object.keys(STRATEGIES)) {
  const rows = results.filter((r) => r.strategy === strategy)
  const ok = rows.filter((r) => r.solved).length
  const cost = rows.reduce((s, r) => s + (r.cost ?? 0), 0)
  const tokens = rows.reduce((s, r) => s + r.outputTokens, 0)
  const secs = rows.reduce((s, r) => s + r.seconds, 0)
  console.log(`${strategy.padEnd(14)} ${`${ok}/${rows.length}`.padEnd(7)} ${cost.toFixed(2).padStart(7)}  ${(ok ? cost / ok : 0).toFixed(2).padStart(12)}  ${String(tokens).padStart(7)}  ${String(secs).padStart(4)}`)
}
