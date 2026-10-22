import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { runLadder, loadConfig, discoverVerify, readInput } from '../../scripts/codex-run.mjs'
import { SCHEMAS, validate, environmentFailure } from '../../scripts/codex-exec.mjs'

const dirs = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fake = fileURLToPath(new URL('../helpers/fake-codex.mjs', import.meta.url))
const write = (root, file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), value) }
const read = (root, file) => readFileSync(join(root, file), 'utf8')
function fixture(scenario = {}, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-codex-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'core.autocrlf', 'false')
  write(dir, '.gitignore', '.model-ladder/\n')
  write(dir, 'greeting.mjs', 'export default "Wellcome"\n')
  write(dir, 'tests/check.test.mjs', 'import assert from "node:assert/strict"\nimport greeting from "../greeting.mjs"\nassert.equal(greeting,"Welcome")\n')
  write(dir, 'scenario.json', JSON.stringify(scenario))
  write(dir, '.codex/model-ladder.json', JSON.stringify({
    router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' },
    tiers: [{ model: 'cheap', efforts: ['low', 'medium', 'high'], maxEffortJump: 1 }, { model: 'strong', efforts: ['low', 'high'], maxEffortJump: 1 }],
    verify: 'node --test tests/check.test.mjs', maxAttempts: 3, ...overrides,
  }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}
const run = (cwd, input = {}, extra = {}) => runLadder({ task: 'Fix greeting typo', ...input }, { cwd, executable: { command: process.execPath, prefixArgs: [fake, cwd] }, ...extra })
const calls = (dir) => read(dir, '.model-ladder/fake-calls.jsonl').trim().split('\n').map(JSON.parse)
const cleaned = (dir) => { assert.equal(existsSync(join(dir, '.model-ladder/run.json')), false); assert.equal(git(dir, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1) }

test('same package identity/version and generated rules do not drift', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const cc = JSON.parse(read(root, '.claude-plugin/plugin.json'))
  const codex = JSON.parse(read(root, '.codex-plugin/plugin.json'))
  assert.equal(cc.name, codex.name)
  assert.equal(cc.version, codex.version)
  assert.equal(codex.skills, './codex-skills/')
  const market = JSON.parse(read(root, '.agents/plugins/marketplace.json'))
  assert.deepEqual(market.plugins[0].source, { source: 'local', path: './' })
  execFileSync(process.execPath, ['scripts/sync-rules.mjs', '--check'], { cwd: root })
})
test('first pass applies incremental changes, ignores benign stderr, records usage and leaves index unchanged', async () => {
  const dir = fixture({ warning: true, newUntracked: true })
  const index = git(dir, 'write-tree')
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(result.outcome.applied, true)
  assert.deepEqual(result.outcome.files, ['greeting.mjs', 'new-file.txt'])
  assert.match(read(dir, 'greeting.mjs'), /Welcome/)
  assert.equal(git(dir, 'write-tree'), index)
  assert.equal(result.usage[0].turns[0].output_tokens, 5)
  assert.deepEqual(calls(dir).map((c) => [c.phase, c.sandbox]), [['route', 'read-only'], ['worker', 'workspace-write'], ['verify', 'workspace-write']])
  assert.ok(calls(dir).every((call) => call.prompt.startsWith('This is one internal model-ladder role. Do not invoke model-ladder')))
  cleaned(dir)
})

test('passing existing tests cannot approve a task rejected by the independent verifier', async () => {
  const dir = fixture({ verifyPass: false }, { maxAttempts: 1 })
  const result = await run(dir)
  assert.equal(result.status, 'FAILED', JSON.stringify(result))
  assert.match(result.attempts[0].reason, /Requested behavior is missing/)
  assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
  cleaned(dir)
})

test('command-backed semantic verification rejects source tampering', async () => {
  const dir = fixture({ verifyFiles: { 'greeting.mjs': 'export default "tampered"\n' } }, { maxAttempts: 1 })
  const result = await run(dir)
  assert.equal(result.status, 'FAILED', JSON.stringify(result))
  assert.match(result.attempts[0].reason, /Verification changed repository files/)
  assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
  cleaned(dir)
})
test('failed test escalates legally, invalid route and move fall back, retry starts from original snapshot', async () => {
  const dir = fixture({ failFirst: true, invalidStart: true, invalidMove: true })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.deepEqual(result.attempts.map((a) => a.cell), ['cheap/low', 'cheap/medium'])
  assert.equal(result.attempts[0].pass, false)
  assert.match(calls(dir).findLast((c) => c.phase === 'worker').prompt, /Fix the greeting/)
  cleaned(dir)
})
test('environment error stops immediately instead of spending on escalation', async () => {
  const dir = fixture({ environment: 'worker' })
  const result = await run(dir)
  assert.equal(result.status, 'STOPPED')
  assert.deepEqual(calls(dir).map((c) => c.phase), ['route', 'worker'])
  assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
  assert.ok(existsSync(result.checkpointPath))
  git(dir, 'worktree', 'remove', '--force', result.worktreePath)
  cleaned(dir)
})
test('diagnosis can stop an environmental test failure', async () => {
  const dir = fixture({ alwaysFail: true, stopEnvironment: true })
  const result = await run(dir)
  assert.equal(result.status, 'STOPPED')
  assert.ok(existsSync(result.checkpointPath))
  git(dir, 'worktree', 'remove', '--force', result.worktreePath)
  cleaned(dir)
})
test('dirty snapshot preserves staged/unstaged edits and real index', async () => {
  const dir = fixture()
  write(dir, 'notes.txt', 'staged note\n')
  git(dir, 'add', 'notes.txt')
  write(dir, 'notes.txt', 'staged plus unstaged note\n')
  write(dir, 'tests/check.test.mjs', read(dir, 'tests/check.test.mjs') + '\n// User test edit\n')
  const index = git(dir, 'write-tree')
  assert.equal((await run(dir)).status, 'DIRTY')
  const result = await run(dir, { allowDirty: true })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(read(dir, 'notes.txt'), 'staged plus unstaged note\n')
  assert.match(read(dir, 'tests/check.test.mjs'), /User test edit/)
  assert.equal(git(dir, 'write-tree'), index)
  assert.deepEqual(result.outcome.files, ['greeting.mjs'])
  cleaned(dir)
})
test('protected test edits including existing user edits cannot be laundered', async () => {
  const dir = fixture({ tamper: 'tests' }, { maxAttempts: 1 })
  write(dir, 'tests/check.test.mjs', read(dir, 'tests/check.test.mjs') + '// User edit\n')
  const result = await run(dir, { allowDirty: true })
  assert.equal(result.status, 'FAILED')
  assert.match(result.attempts[0].reason, /protected file/)
  assert.match(read(dir, 'tests/check.test.mjs'), /User edit/)
  cleaned(dir)
})
test('test-writing permission keeps Codex configuration protected', async () => {
  const dir = fixture({ tamper: 'config', allowTests: true }, { maxAttempts: 1 })
  const result = await run(dir)
  assert.equal(result.status, 'FAILED')
  assert.match(result.attempts[0].reason, /protected file .codex/)
  cleaned(dir)
})
test('verification itself may not tamper with tests or source', async () => {
  const dir = fixture({}, { maxAttempts: 1, verify: 'node -e "require(\'fs\').appendFileSync(\'tests/check.test.mjs\',\'tampered\')"' })
  const result = await run(dir)
  assert.equal(result.status, 'FAILED')
  assert.match(result.attempts[0].reason, /Verification changed|protected/)
  cleaned(dir)
})
test('without existing verification the user must supply acceptance', async () => {
  const dir = fixture({}, { verify: null })
  const result = await run(dir)
  assert.equal(result.status, 'NEEDS_INPUT')
  assert.equal(result.attempts.length, 0)
  assert.match(result.message, /acceptance/)
  cleaned(dir)
  const accepted = await run(dir, { acceptance: ['Greeting is Welcome'] })
  assert.equal(accepted.status, 'VERIFIED', JSON.stringify(accepted))
  assert.ok(calls(dir).some((c) => c.phase === 'verify'))
  cleaned(dir)
})
test('vague task asks its clarifying question', async () => {
  const dir = fixture({ question: 'Which greeting?' })
  assert.equal((await run(dir)).message, 'Which greeting?')
  cleaned(dir)
})
test('read-only report does not apply or stage user edits', async () => {
  const dir = fixture({ readOnly: true })
  write(dir, 'notes.txt', 'user note\n')
  const before = git(dir, 'write-tree')
  const result = await run(dir, { allowDirty: true })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.match(result.summary, /Greeting comes from/)
  assert.equal(result.outcome.applied, false)
  assert.equal(git(dir, 'write-tree'), before)
  assert.equal(read(dir, 'notes.txt'), 'user note\n')
  assert.ok(calls(dir).find((c) => c.phase === 'worker').sandbox === 'read-only')
  cleaned(dir)
})
test('patch conflict retains the verified worktree and patch without overwriting concurrent work', async () => {
  const dir = fixture({ conflict: true })
  const result = await run(dir)
  assert.equal(result.status, 'CONFLICT', JSON.stringify(result))
  assert.ok(existsSync(result.outcome.patch))
  assert.ok(existsSync(result.worktreePath))
  assert.match(read(dir, 'greeting.mjs'), /Concurrent edit/)
  git(dir, 'worktree', 'remove', '--force', result.worktreePath)
  cleaned(dir)
})
test('cleanup never removes an unrelated worktree created during a run', async () => {
  const unrelated = mkdtempSync(join(tmpdir(), 'ml-unrelated-'))
  dirs.push(unrelated)
  rmSync(unrelated, { recursive: true })
  const dir = fixture({ createUnrelated: unrelated })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.ok(existsSync(unrelated))
  git(dir, 'worktree', 'remove', '--force', unrelated)
  cleaned(dir)
})
test('existing Claude marker blocks Codex and is never removed', async () => {
  const dir = fixture()
  write(dir, '.model-ladder/run.json', '{"runtime":"claude"}')
  const result = await run(dir)
  assert.equal(result.status, 'STALE_RUN')
  assert.equal(read(dir, '.model-ladder/run.json'), '{"runtime":"claude"}')
})
test('invalid structured response is rejected at boundary', async () => {
  const dir = fixture({ badOutput: 'worker' }, { maxAttempts: 1 })
  const result = await run(dir)
  assert.equal(result.status, 'FAILED')
  assert.match(result.attempts[0].reason, /invalid output/)
  assert.throws(() => validate({ pass: true, reason: '', output: '', injected: true }, SCHEMAS.verify), /unexpected property/)
  cleaned(dir)
})
test('timeout cancels the child and releases the run marker', async () => {
  const dir = fixture({ delay: 5000 }, { timeoutMs: 1000 })
  const result = await run(dir)
  assert.equal(result.status, 'STOPPED', JSON.stringify(result))
  assert.match(result.message, /Timed out/)
  assert.ok(existsSync(result.worktreePath))
  assert.ok(existsSync(result.checkpointPath))
  assert.match(result.attempts[0].reason, /Timed out/)
  assert.ok(readdirSync(join(dir, '.model-ladder', result.runId)).some((file) => /^worker-.*events.jsonl$/.test(file)))
  assert.equal(existsSync(join(dir, '.model-ladder/run.json')), false)
})

test('interrupted drafts resume in a new worktree only against the original task and checkout', async () => {
  const dir = fixture({ delay: 10000, delayFirst: true, partialFiles: { 'draft.txt': 'unfinished draft' }, expectWorkerFiles: { 'draft.txt': 'unfinished draft' } }, { timeoutMs: 2000 })
  const stopped = await run(dir)
  assert.equal(stopped.status, 'STOPPED', JSON.stringify(stopped))
  assert.equal(read(stopped.worktreePath, 'draft.txt'), 'unfinished draft')
  assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
  const resumeRun = stopped.resumeRun
  assert.equal((await run(dir, { resumeRun, task: 'Different task' })).status, 'ERROR')
  write(dir, 'notes.txt', 'new user change')
  assert.equal((await run(dir, { resumeRun })).status, 'DIRTY')
  assert.equal((await run(dir, { resumeRun, allowDirty: true })).status, 'ERROR')
  rmSync(join(dir, 'notes.txt'))
  write(stopped.worktreePath, 'tests/check.test.mjs', 'process.exit(0)\n')
  const tampered = await run(dir, { resumeRun })
  assert.equal(tampered.status, 'ERROR')
  assert.match(tampered.message, /protected/)
  write(stopped.worktreePath, 'tests/check.test.mjs', read(dir, 'tests/check.test.mjs'))
  const result = await run(dir, { resumeRun })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(read(dir, 'draft.txt'), 'unfinished draft')
  assert.notEqual(result.attempts[0].worktreePath, stopped.worktreePath)
  assert.equal(read(stopped.worktreePath, 'draft.txt'), 'unfinished draft')
  assert.ok(calls(dir).findLast((call) => call.phase === 'verify'))
  git(dir, 'worktree', 'remove', '--force', stopped.worktreePath)
  cleaned(dir)
})

test('UTF-8 JSON files preserve Chinese including a PowerShell UTF-8 BOM', async () => {
  const dir = fixture()
  const file = join(dir, '.model-ladder', 'input.json')
  const input = { task: '修正中文問候', acceptance: ['問候必須正確'] }
  write(dir, '.model-ladder/input.json', '\uFEFF' + JSON.stringify(input))
  assert.deepEqual(readInput(['--input', file]), input)
  const result = await runLadder(readInput(['--input', file]), { cwd: dir, executable: { command: process.execPath, prefixArgs: [fake, dir] } })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.ok(calls(dir).every((call) => call.prompt.includes(input.task)))
  cleaned(dir)
})

test('CLI reports waiting statuses with exit 2 and errors with exit 1', () => {
  const dir = fixture()
  const runner = fileURLToPath(new URL('../../scripts/codex-run.mjs', import.meta.url))
  const file = join(dir, '.model-ladder', 'input.json')
  const invoke = (input) => {
    write(dir, '.model-ladder/input.json', '\uFEFF' + JSON.stringify(input))
    const child = spawnSync(process.execPath, [runner, '--input', file], { cwd: dir, encoding: 'utf8' })
    return { code: child.status, result: JSON.parse(child.stdout) }
  }
  assert.deepEqual(invoke({ task: '' }), { code: 2, result: { status: 'NEEDS_INPUT', message: 'Provide a task with a clear outcome.' } })
  write(dir, 'notes.txt', 'dirty')
  assert.equal(invoke({ task: 'Fix greeting' }).code, 2)
  assert.equal(invoke({ task: 'Fix greeting' }).result.status, 'DIRTY')
  rmSync(join(dir, 'notes.txt'))
  write(dir, '.model-ladder/run.json', '{"runtime":"claude"}')
  const stale = invoke({ task: 'Fix greeting' })
  assert.equal(stale.code, 2)
  assert.equal(stale.result.status, 'STALE_RUN')
  const invalid = invoke({ task: 'Fix greeting', allowDirty: 'yes' })
  assert.equal(invalid.code, 1)
  assert.equal(invalid.result.status, 'ERROR')
})
test('invalid configuration and acceptance stop before a model call; native discovery uses existing tests', async () => {
  const dir = fixture({}, { maxAttempts: 0 })
  assert.equal((await run(dir)).status, 'ERROR')
  assert.equal((await run(dir, { acceptance: [1] })).status, 'ERROR')
  assert.throws(() => loadConfig(dir), /positive integers/)
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }))
  assert.equal(discoverVerify(dir), 'npm test')
})
const seed = (dir, files) => {
  for (const [file, value] of Object.entries(files)) write(dir, file, value)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'verification inputs')
}
const npmPackage = (scripts = { test: 'node --test tests/check.test.mjs' }, dependencies = {}) => JSON.stringify({ scripts, dependencies })

test('applying verified patches preserves EOF whitespace and binary bytes exactly', async () => {
  const contents = { 'z-end.txt': 'new\n   \n', 'a-binary.bin': '\0\u0001binary\u00ff\n' }
  const dir = fixture({ workerFiles: contents })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  for (const [file, value] of Object.entries(contents)) assert.deepEqual(readFileSync(join(dir, file)), Buffer.from(value))
  cleaned(dir)
})

test('unsupported ChatGPT-account model stops without diagnosis or escalation', async () => {
  assert.equal(environmentFailure('The reasoning effort ultra is not supported for this model.'), true)
  const dir = fixture({ environment: 'worker', environmentMessage: 'The gpt-6-luna model is not supported when using Codex with a ChatGPT account.' })
  const result = await run(dir)
  assert.equal(result.status, 'STOPPED', JSON.stringify(result))
  assert.deepEqual(calls(dir).map((c) => c.phase), ['route', 'worker'])
  assert.ok(existsSync(result.checkpointPath))
  git(dir, 'worktree', 'remove', '--force', result.worktreePath)
  cleaned(dir)
})

test('configured and discovered npm verification cannot be replaced by the worker', async () => {
  for (const verify of [null, 'npm test']) {
    const dir = fixture({ alwaysFail: true, workerFiles: { 'package.json': npmPackage({ test: 'node -e "process.exit(0)"' }) } }, { verify, maxAttempts: 1 })
    seed(dir, { 'package.json': npmPackage() })
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /protected file package.json scripts/)
    assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
    assert.equal(read(dir, 'package.json'), npmPackage())
    cleaned(dir)
  }
})

test('npm verification protects hooks, nested scripts and npm configuration', async () => {
  for (const workerFiles of [
    { 'package.json': npmPackage({ test: 'node --test tests/check.test.mjs', pretest: 'node -e "process.exit(0)"' }) },
    { 'package.json': npmPackage({ test: 'npm run check', check: 'node -e "process.exit(0)"' }) },
    { '.npmrc': 'ignore-scripts=true\n' },
  ]) {
    const dir = fixture({ workerFiles }, { verify: 'npm test', maxAttempts: 1 })
    seed(dir, { 'package.json': npmPackage({ test: 'npm run check', check: 'node --test tests/check.test.mjs' }) })
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /protected file/)
    cleaned(dir)
  }
})

test('unchanged npm scripts permit dependency changes and preserve dirty user script baseline', async () => {
  const scripts = { test: 'node --test tests/check.test.mjs', pretest: 'node -e "process.exit(0)"' }
  const dir = fixture({ workerFiles: { 'package.json': npmPackage(scripts, { 'example-dependency': '1.0.0' }) } }, { verify: null })
  seed(dir, { 'package.json': npmPackage() })
  write(dir, 'package.json', npmPackage(scripts))
  const result = await run(dir, { allowDirty: true })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.deepEqual(JSON.parse(read(dir, 'package.json')).scripts, scripts)
  assert.equal(JSON.parse(read(dir, 'package.json')).dependencies['example-dependency'], '1.0.0')
  cleaned(dir)
})

test('selected verify skill and helper files are protected before verification', async () => {
  for (const folder of ['.agents/skills/verify', '.claude/skills/verify']) {
    for (const file of ['SKILL.md', 'check.mjs']) {
      const dir = fixture({ workerFiles: { [folder + '/' + file]: 'Always pass\n' } }, { verify: null, maxAttempts: 1 })
      seed(dir, { [folder + '/SKILL.md']: 'Run check.mjs', [folder + '/check.mjs']: 'throw Error("real check")' })
      const result = await run(dir)
      assert.equal(result.status, 'FAILED', JSON.stringify(result))
      assert.match(result.attempts[0].reason, /protected file/)
      assert.equal(calls(dir).some((c) => c.phase === 'verify'), false)
      cleaned(dir)
    }
  }
})

test('skill and acceptance verification can build while reports remain read-only', async () => {
  const dir = fixture({ verifyFiles: { 'target/debug/check': 'build artifact' } }, { verify: null })
  seed(dir, { '.agents/skills/verify/SKILL.md': 'Run cargo test' })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(calls(dir).find((c) => c.phase === 'verify').sandbox, 'workspace-write')
  assert.equal(existsSync(join(dir, 'target')), false)
  cleaned(dir)
  const report = fixture({ readOnly: true }, { verify: null })
  seed(report, { '.agents/skills/verify/SKILL.md': 'Review report' })
  assert.equal((await run(report)).status, 'VERIFIED')
  assert.equal(calls(report).find((c) => c.phase === 'verify').sandbox, 'read-only')
  cleaned(report)
  const acceptance = fixture({ verifyFiles: { 'dist/check.mjs': 'build artifact' } }, { verify: null })
  assert.equal((await run(acceptance, { acceptance: ['Greeting is Welcome'] })).status, 'VERIFIED')
  assert.equal(calls(acceptance).find((c) => c.phase === 'verify').sandbox, 'workspace-write')
  assert.equal(existsSync(join(acceptance, 'dist')), false)
  cleaned(acceptance)
})

test('skill verification still rejects source and helper edits after verification', async () => {
  for (const file of ['greeting.mjs', '.agents/skills/verify/check.mjs']) {
    const dir = fixture({ verifyFiles: { [file]: 'tampered' } }, { verify: null, maxAttempts: 1 })
    seed(dir, { '.agents/skills/verify/SKILL.md': 'Run check.mjs', '.agents/skills/verify/check.mjs': 'real checks' })
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /Verification changed|protected/)
    assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
    cleaned(dir)
  }
})

test('discovered non-npm verifier definitions cannot be replaced before execution', async () => {
  for (const [file, baseline] of Object.entries({ 'Makefile': 'test:\n\tfalse\n', 'pytest.ini': '[pytest]\n', 'pyproject.toml': '[tool.pytest.ini_options]\n', 'Cargo.toml': '[package]\nname="test"\n', 'go.mod': 'module test\n', 'pom.xml': '<project/>' })) {
    const dir = fixture({ workerFiles: { [file]: 'tampered' } }, { verify: null, maxAttempts: 1 })
    seed(dir, { [file]: baseline, ...(file === 'pyproject.toml' ? { 'tests/example.py': '' } : {}) })
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /protected file/)
    cleaned(dir)
  }
})

test('deleted and renamed verification inputs remain protected', async () => {
  const cases = [
    { verify: 'npm test', files: { 'package.json': npmPackage() }, edits: { 'package.json': null } },
    { verify: null, files: { '.agents/skills/verify/SKILL.md': 'Run check', '.agents/skills/verify/check.mjs': 'real check' }, edits: { '.agents/skills/verify/check.mjs': null, 'renamed-check.mjs': 'real check' } },
  ]
  for (const { verify, files, edits } of cases) {
    const dir = fixture({ workerFiles: edits }, { verify, maxAttempts: 1 })
    seed(dir, files)
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /protected file/)
    cleaned(dir)
  }
})

test('npm prefix and workspace delegation protect nested manifest scripts while permitting dependencies', async () => {
  const scripts = { test: 'node --test ../tests/check.test.mjs' }
  for (const verify of ['npm --prefix frontend test', 'npm test']) {
    const dir = fixture({ alwaysFail: true, workerFiles: { 'frontend/package.json': npmPackage({ test: 'node -e "process.exit(0)"' }) } }, { verify, maxAttempts: 1 })
    seed(dir, { 'package.json': npmPackage({ test: 'npm --prefix frontend test' }), 'frontend/package.json': npmPackage(scripts) })
    const result = await run(dir)
    assert.equal(result.status, 'FAILED', JSON.stringify(result))
    assert.match(result.attempts[0].reason, /protected file frontend\/package.json scripts/)
    assert.match(read(dir, 'greeting.mjs'), /Wellcome/)
    cleaned(dir)
  }
  const dir = fixture({ workerFiles: { 'frontend/package.json': npmPackage(scripts, { example: '1.0.0' }) } }, { verify: 'npm --prefix frontend test' })
  seed(dir, { 'frontend/package.json': npmPackage(scripts) })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(JSON.parse(read(dir, 'frontend/package.json')).dependencies.example, '1.0.0')
  cleaned(dir)
})
