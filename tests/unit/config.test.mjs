import { freshUserConfig } from '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GUARD_DEFAULT, mergeConfig, parseThreshold, pluginLayer, projectPins, setGuard, userConfigPath } from '../../hooks/config-layers.mjs'
import { loadLayered, userConfigPath as nodeUserConfigPath, writeUserGuard } from '../../scripts/config.mjs'
import { DEFAULTS as CLAUDE_DEFAULTS, loadConfig as loadClaude } from '../../scripts/preflight.mjs'
import { DEFAULTS as CODEX_DEFAULTS, loadConfig as loadCodex } from '../../scripts/codex-run.mjs'
import { configureGuard, panelCommand } from '../../scripts/watch.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ml-config-'))
  dirs.push(d)
  return d
}
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

test('layers: defaults, then user, then project; usageGuard merges field by field', () => {
  const defaults = { a: 1, b: 1, c: 1, usageGuard: GUARD_DEFAULT }
  const merged = mergeConfig(defaults, { b: 2, c: 2, usageGuard: { enabled: false } }, { c: 3, usageGuard: { threshold: 70 } })
  assert.deepEqual(merged, { a: 1, b: 2, c: 3, usageGuard: { enabled: false, threshold: 70 } })
  assert.deepEqual(mergeConfig(defaults).usageGuard, { enabled: true, threshold: 90 })
})

test('user file path: env override first, then CLAUDE_CONFIG_DIR / CODEX_HOME, then the home folder', () => {
  assert.equal(userConfigPath('claude', { MODEL_LADDER_USER_CONFIG: '/x/u.json', CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/x/u.json')
  assert.equal(userConfigPath('codex', { MODEL_LADDER_USER_CONFIG: '/x/u.json', CODEX_HOME: '/k' }, '/h'), '/x/u.json')
  assert.equal(userConfigPath('claude', { CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c/model-ladder.json')
  assert.equal(userConfigPath('codex', { CODEX_HOME: '/k' }, '/h'), '/k/model-ladder.json')
  assert.equal(userConfigPath('claude', {}, '/h'), '/h/.claude/model-ladder.json')
  assert.equal(userConfigPath('codex', {}, '/h'), '/h/.codex/model-ladder.json')
})

test('tests never point at the real home folder', () => {
  for (const runtime of ['claude', 'codex']) {
    const path = nodeUserConfigPath(runtime).replaceAll('\\', '/').toLowerCase()
    assert.ok(!path.startsWith(`${homedir().replaceAll('\\', '/').toLowerCase()}/.`), path)
    assert.ok(path.startsWith(tmpdir().replaceAll('\\', '/').toLowerCase()), path)
  }
  const files = readdirSync(join(root, 'tests', 'unit')).filter((f) => f.endsWith('.test.mjs'))
  for (const file of files) {
    const first = readFileSync(join(root, 'tests', 'unit', file), 'utf8').split('\n')[0]
    assert.match(first, /^import .*'\.\.\/helpers\/isolate-home\.mjs'$/, `${file} must import ../helpers/isolate-home.mjs first`)
  }
})

test('plugin skill options: only filled-in strings count', () => {
  assert.deepEqual(pluginLayer({ worker_skills: 'use ponytail', verifier_skills: '${user_config.verifier_skills}', band: true }), { worker_skills: 'use ponytail' })
  assert.deepEqual(pluginLayer({ worker_skills: '', verifier_skills: 3 }), { worker_skills: '' })
  assert.deepEqual(pluginLayer(undefined), {})
})

test('band threshold save changes the threshold only: an off guard stays off', () => {
  assert.deepEqual(setGuard({ tiers: 'x', usageGuard: { enabled: false, threshold: 90 } }, { threshold: 70 }), { tiers: 'x', usageGuard: { enabled: false, threshold: 70 } })
  assert.deepEqual(setGuard({}, { threshold: 70 }), { usageGuard: { threshold: 70 } }, 'no enabled is written when there was none')
  assert.deepEqual(setGuard({ usageGuard: { enabled: true, threshold: 80 } }, { enabled: false }), { usageGuard: { enabled: false, threshold: 80 } })
  for (const [text, n] of [['85', 85], [' 85% ', 85], ['1', 1], ['100', 100], ['90.5', 90.5], ['0', null], ['101', null], ['abc', null], ['', null], ['1e2', null]]) assert.equal(parseThreshold(text), n, text)
  assert.equal(projectPins({ usageGuard: { enabled: false } }, 'enabled'), true)
  assert.equal(projectPins({ usageGuard: { enabled: false } }, 'threshold'), false)
  assert.equal(projectPins({}, 'enabled'), false)
})

test('band: the threshold save and switch go through setGuard into the user file, never the project file', () => {
  const band = readFileSync(join(root, 'hooks/band/register.tsx'), 'utf8')
  assert.match(band, /editUserConfig\(\$, \(c\) => setGuard\(c, \{ threshold: n \}\)\)/)
  assert.match(band, /editUserConfig\(\$, \(c\) => setGuard\(c, \{ enabled: !enabled \}\)\)/)
  assert.doesNotMatch(band, /enabled: true, threshold/)
  assert.doesNotMatch(band, /fs\.write\(await projectPath/)
  assert.equal(band.match(/\$\.fs\.write\(/g).length, 4, 'usage.json, context.json, HANDOFF.md and the user settings file only')
})

test('Claude Code settings read ~/.claude/model-ladder.json between the defaults and the project', () => {
  const user = freshUserConfig()
  const repo = tmp()
  writeJson(user, { maxAttempts: 2, keepFailed: true, usageGuard: { enabled: false } })
  writeJson(join(repo, '.claude/model-ladder.json'), { maxAttempts: 3 })
  const { config, problems } = loadClaude(repo)
  assert.deepEqual(problems, [])
  assert.equal(config.maxAttempts, 3)
  assert.equal(config.keepFailed, true)
  assert.deepEqual(config.usageGuard, { enabled: false, threshold: 90 })
  assert.deepEqual(loadLayered(repo, 'claude', CLAUDE_DEFAULTS, { worker_skills: 'plugin' }).worker_skills, 'plugin')
  freshUserConfig()
})

test('direct_threshold layers: default, user file, project file, plugin option', () => {
  const user = freshUserConfig()
  const repo = tmp()
  assert.equal(loadClaude(repo).config.direct_threshold, 30)
  writeJson(user, { direct_threshold: 40 })
  assert.equal(loadClaude(repo).config.direct_threshold, 40)
  assert.equal(loadClaude(repo, { direct_threshold: '60' }).config.direct_threshold, 60)
  writeJson(join(repo, '.claude/model-ladder.json'), { direct_threshold: 'off' })
  assert.equal(loadClaude(repo, { direct_threshold: '60' }).config.direct_threshold, 'off')
  assert.deepEqual(pluginLayer({ direct_threshold: '80' }), { direct_threshold: 80 })
  assert.deepEqual(pluginLayer({ direct_threshold: 'off' }), { direct_threshold: 'off' })
  assert.deepEqual(pluginLayer({ direct_threshold: '${user_config.direct_threshold}' }), {})
  freshUserConfig()
})

test('split_minutes layers: default, user file, project file, plugin option', () => {
  const user = freshUserConfig()
  const repo = tmp()
  assert.equal(loadClaude(repo).config.split_minutes, 20)
  writeJson(user, { split_minutes: 30 })
  assert.equal(loadClaude(repo).config.split_minutes, 30)
  assert.equal(loadClaude(repo, { split_minutes: '45' }).config.split_minutes, 45)
  writeJson(join(repo, '.claude/model-ladder.json'), { split_minutes: 'off' })
  assert.equal(loadClaude(repo, { split_minutes: '45' }).config.split_minutes, 'off')
  assert.deepEqual(loadClaude(repo).problems, [])
  assert.deepEqual(pluginLayer({ split_minutes: '60' }), { split_minutes: 60 })
  assert.deepEqual(pluginLayer({ split_minutes: 'off' }), { split_minutes: 'off' })
  assert.deepEqual(pluginLayer({ split_minutes: '${user_config.split_minutes}' }), {})
  writeJson(join(repo, '.claude/model-ladder.json'), { split_minutes: 'later' })
  assert.match(loadClaude(repo).problems.join(';'), /split_minutes must be/)
  freshUserConfig()
})

test('Codex tolerates split_minutes in its settings', () => {
  const user = freshUserConfig()
  const repo = tmp()
  writeJson(user, { split_minutes: 30 })
  assert.deepEqual(loadCodex(repo).split_minutes, 30)
  freshUserConfig()
})

test('Codex tolerates direct_threshold in its settings', () => {
  const user = freshUserConfig()
  const repo = tmp()
  writeJson(user, { direct_threshold: 50 })
  assert.deepEqual(loadCodex(repo).direct_threshold, 50)
  freshUserConfig()
})

test('Codex settings read ~/.codex/model-ladder.json between the defaults and the project', () => {
  const user = freshUserConfig()
  const repo = tmp()
  writeJson(user, { timeoutMs: 1234, usageGuard: { enabled: false, threshold: 50 }, worker_skills: 'mine' })
  writeJson(join(repo, '.codex/model-ladder.json'), { usageGuard: { threshold: 60 } })
  const config = loadCodex(repo)
  assert.equal(config.timeoutMs, 1234)
  assert.equal(config.worker_skills, 'mine')
  assert.deepEqual(config.usageGuard, { enabled: false, threshold: 60 })
  assert.equal(config.router.model, CODEX_DEFAULTS.router.model)
  writeJson(user, '[1]')
  assert.throws(() => loadCodex(repo), /must hold a JSON object/)
  freshUserConfig()
})

test('writeUserGuard changes one field of the user file and keeps everything else', () => {
  const user = freshUserConfig()
  writeJson(user, { tiers: 'keep', usageGuard: { enabled: false, threshold: 90 } })
  writeUserGuard('claude', { threshold: 75 })
  assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')), { tiers: 'keep', usageGuard: { enabled: false, threshold: 75 } })
  freshUserConfig()
})

test('docs in both languages describe the two layers, the plugin skill options and the hard-limit handoff', () => {
  const doc = (file) => readFileSync(join(root, file), 'utf8')
  for (const file of ['README.md', 'README.zh-TW.md', 'DESIGN.md', 'DESIGN.zh-TW.md']) {
    for (const text of ['~/.claude/model-ladder.json', '~/.codex/model-ladder.json', 'worker_skills', 'USAGE_LIMIT']) assert.ok(doc(file).includes(text), `${file}: ${text}`)
  }
  for (const file of ['README.md', 'README.zh-TW.md']) assert.match(doc(file), /Worker skill instructions/, file)
  for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-TW.md']) {
    const changelog = doc(file)
    for (const text of ['~/.claude/model-ladder.json', 'verifier_skills', 'USAGE_LIMIT', 'HANDOFF.md']) assert.ok(changelog.includes(text), `${file}: ${text}`)
  }
})

test('watch g and t write the user file; a project that pins the field is reported, never rewritten', () => {
  const user = freshUserConfig()
  const repo = tmp()
  const project = { usageGuard: { enabled: false }, verify: 'npm test' }
  writeJson(join(repo, '.codex/model-ladder.json'), project)
  const before = readFileSync(join(repo, '.codex/model-ladder.json'), 'utf8')
  assert.match(panelCommand(repo, 'g'), /Usage guard on \(saved to .*\.codex\/model-ladder\.json sets usageGuard\.enabled for this project and wins\)/)
  assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')), { usageGuard: { enabled: true } })
  assert.equal(configureGuard(repo, {}).enabled, false, 'the project pin still decides here')
  assert.equal(panelCommand(repo, 't 70'), 'Threshold 70%')
  assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')), { usageGuard: { enabled: true, threshold: 70 } })
  assert.equal(readFileSync(join(repo, '.codex/model-ladder.json'), 'utf8'), before)
  freshUserConfig()
})
