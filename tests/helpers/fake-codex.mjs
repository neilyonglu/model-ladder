import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
const [root, ...args] = process.argv.slice(2)
let prompt = ''
for await (const data of process.stdin) prompt += data
assert.equal(args[0], 'exec')
const arg = (name) => args[args.indexOf(name) + 1]
const cwd = arg('-C')
const phase = basename(arg('--output-schema')).split('.')[0]
assert.equal(process.env.MODEL_LADDER_ROLE, phase)
assert.equal(process.env.MODEL_LADDER_BAND, '0')
assert.equal(process.env.MODEL_LADDER_AUTORUN, '0')
const schema = JSON.parse(readFileSync(arg('--output-schema'), 'utf8'))
assert.equal(schema.additionalProperties, false)
assert.deepEqual(schema.required, Object.keys(schema.properties))
assert.ok(args.includes('--ephemeral'))
assert.ok(args.includes('--json'))
assert.equal(args.at(-1), '-')
assert.match(arg('-c'), /^model_reasoning_effort=/)
assert.ok(['read-only', 'workspace-write'].includes(arg('--sandbox')))
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'))
const log = join(root, '.model-ladder', 'fake-calls.jsonl')
mkdirSync(join(root, '.model-ladder'), {recursive:true})
appendFileSync(log, JSON.stringify({phase,cwd,model:arg('-m'),effort:arg('-c'),sandbox:arg('--sandbox'),prompt}) + '\n')
const calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
const number = calls.filter((call) => call.phase === 'worker').length
if (scenario.environment === phase) { console.error(scenario.environmentMessage ?? 'model unsupported or sandbox permission denied'); process.exit(1) }
if (scenario.warning) console.error('sandbox initialized normally')
let output
if (phase === 'route') output = {model:scenario.invalidStart ? 'no-model' : 'cheap',effort:'low',reason:'small task',goal:'Fix greeting',scope:['greeting.mjs'],allowTests:scenario.allowTests ?? false,readOnly:scenario.readOnly ?? false,question:scenario.question ?? null}
if (phase === 'worker') {
  for (const [file, value] of Object.entries(scenario.expectWorkerFiles ?? {})) {
    if (number > 1) assert.equal(readFileSync(join(cwd, file), 'utf8'), value)
  }
  for (const [file, value] of Object.entries(scenario.partialFiles ?? {})) {
    if (number === 1) writeFileSync(join(cwd, file), value)
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Worker started' } }))
  if (scenario.delay && (!scenario.delayFirst || number === 1)) await new Promise((resolve) => setTimeout(resolve,scenario.delay))
  if (!scenario.readOnly) writeFileSync(join(cwd,'greeting.mjs'), 'export default ' + JSON.stringify(scenario.failFirst && number === 1 || scenario.alwaysFail ? 'Wrong' : 'Welcome') + '\n')
  for (const [file, value] of Object.entries(scenario.workerFiles ?? {})) {
    mkdirSync(join(cwd, file, '..'), { recursive: true })
    if (value === null) rmSync(join(cwd, file), { force: true })
    else writeFileSync(join(cwd, file), value)
  }
  if (scenario.tamper === 'tests') writeFileSync(join(cwd,'tests/check.test.mjs'),'process.exit(0)\n')
  if (scenario.tamper === 'config') writeFileSync(join(cwd,'.codex/model-ladder.json'),'{}\n')
  if (scenario.conflict) writeFileSync(join(root,'greeting.mjs'),'export default "Concurrent edit"\n')
  if (scenario.newUntracked) writeFileSync(join(cwd,'new-file.txt'),'new content\n')
  if (scenario.createUnrelated) {
    const {execFileSync} = await import('node:child_process')
    execFileSync('git',['worktree','add','--detach','-q',scenario.createUnrelated,'HEAD'],{cwd:root})
  }
  output = {status:'done',summary:scenario.readOnly ? 'Greeting comes from greeting.mjs.' : 'Fixed greeting',blockedReason:null}
}
if (phase === 'verify') {
  for (const [file, value] of Object.entries(scenario.verifyFiles ?? {})) {
    mkdirSync(join(cwd, file, '..'), { recursive: true })
    writeFileSync(join(cwd, file), value)
  }
}
if (phase === 'verify') output = {pass:scenario.verifyPass ?? true,reason:scenario.verifyPass === false ? 'Requested behavior is missing' : 'Criteria met',output:'Inspected actual source'}
if (phase === 'diagnose') output = {action:scenario.stopEnvironment ? 'stop_environment':'raise_effort',model:scenario.invalidMove ? 'unavailable':'cheap',effort:scenario.invalidMove ? 'ultra':'medium',reason:'Retry',hint:'Fix the greeting'}
if (scenario.badOutput === phase) output = {invalid:true}
writeFileSync(arg('-o'),JSON.stringify(output))
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:5,reasoning_output_tokens:0}}))
