// Checks the repo, snapshots uncommitted work, writes this run's lock (.model-ladder/runs/<runId>.json),
// and prints the runId and workflow args as JSON. Other active runs do not stop it; scripts/claim.mjs
// compares scopes after routing. Stops at the first thing the user must decide, as a status:
//   ERROR       not runnable (message)
//   STALE_RUN   a run lock looks stale (locks) -> ask; rerun with --clear-stale
//   OVERRIDDEN  env vars override the ladder -> ask; rerun with --ignore-env
//   DIRTY       uncommitted changes (files)  -> ask; rerun with --allow-dirty
//   USAGE_LIMIT usageGuard is on and the subscription usage is at the threshold -> stop
//   READY       workflowArgs to pass to the model-ladder:ladder workflow
// Settings: defaults, then ~/.claude/model-ladder.json (personal), then .claude/model-ladder.json (project).
// `--plugin-options` reads {"worker_skills", "verifier_skills", "direct_threshold", "split_minutes"} on stdin: the plugin's userConfig values, the
// defaults for every project; a project key of the same name wins, and an unfilled "${...}" counts as unset.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALWAYS_PROTECTED, TEST_PATTERNS } from '../hooks/guard.mjs'
import { ensureGitExclude, git, print, pruneRuns, repoRoot, runDir, tryGit, worktrees } from './common.mjs'
import { clearStale, clearStaleFlag, createLock, readLocks, releaseLock, runFiles, withMutex } from './runs.mjs'
import { GUARD_DEFAULT } from '../hooks/config-layers.mjs'
import { loadLayered, userConfigPath } from './config.mjs'
import { claudeGuard, guardStops } from './usage-guard.mjs'

export const DEFAULTS = {
  router: { model: 'sonnet', effort: 'low' },
  verifier: { model: 'haiku', effort: 'low' },
  tiers: [
    { model: 'haiku', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
    { model: 'sonnet', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
    { model: 'opus', efforts: ['low', 'medium', 'high', 'xhigh'], maxEffortJump: 1 },
  ],
  maxAttempts: 4,
  verify: null,
  protected: [],
  commit: false,
  keepFailed: false,
  usageGuard: GUARD_DEFAULT,
  // Natural-language skill instructions per role: the plugin options, overridden per project.
  worker_skills: '',
  verifier_skills: '',
  // A small task goes DIRECT when the session holds at least this % of its context window, or "off".
  direct_threshold: 30,
  // A task the router estimates at more than this many minutes is offered in parts, or "off".
  split_minutes: 20,
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const OWN = [':!.claude/worktrees', ':!.model-ladder']

export function loadConfig(root, pluginOptions = {}) {
  const config = loadLayered(root, 'claude', DEFAULTS, pluginOptions)
  const problems = []
  const cell = (c, name) => (typeof c?.model === 'string' && EFFORTS.includes(c?.effort)) || problems.push(`${name} needs a model and an effort (${EFFORTS.join(', ')})`)
  cell(config.router, 'router')
  cell(config.verifier, 'verifier')
  if (!Array.isArray(config.tiers) || !config.tiers.length) problems.push('tiers must be a non-empty list')
  for (const tier of config.tiers ?? []) {
    if (typeof tier.model !== 'string') problems.push('every tier needs a model')
    if (!tier.efforts?.length || tier.efforts.some((e) => !EFFORTS.includes(e))) problems.push(`tier ${tier.model}: efforts must be from ${EFFORTS.join(', ')}`)
    if (!(tier.maxEffortJump >= 1)) problems.push(`tier ${tier.model}: maxEffortJump must be 1 or more`)
  }
  if (!(config.maxAttempts >= 1)) problems.push('maxAttempts must be 1 or more')
  if (!Array.isArray(config.protected)) problems.push('protected must be a list of globs')
  const guard = config.usageGuard
  if (typeof guard.enabled !== 'boolean') problems.push('usageGuard.enabled must be true or false')
  if (typeof guard.threshold !== 'number' || !(guard.threshold >= 1 && guard.threshold <= 100)) problems.push('usageGuard.threshold must be a number from 1 to 100')
  const dt = config.direct_threshold
  if (dt !== 'off' && !(typeof dt === 'number' && dt > 0 && dt <= 100)) problems.push('direct_threshold must be a number from 1 to 100, or "off"')
  const sm = config.split_minutes
  if (sm !== 'off' && !(typeof sm === 'number' && sm > 0)) problems.push('split_minutes must be a number of minutes greater than 0, or "off"')
  for (const key of ['worker_skills', 'verifier_skills']) if (typeof config[key] !== 'string') problems.push(`${key} must be a string of skill instructions`)
  return { config, problems }
}

const CONTEXT_FRESH_MS = 10 * 60 * 1000

// The context size the band measured (.model-ladder/context.json), when it is under 10 minutes old; else {}.
export function measuredContext(root, now = Date.now()) {
  try {
    const c = JSON.parse(readFileSync(join(root, '.model-ladder', 'context.json'), 'utf8'))
    const age = now - c.updatedAt * 1000
    if (typeof c.tokens !== 'number' || !(c.tokens >= 0) || !(age >= -60000 && age < CONTEXT_FRESH_MS)) return {}
    return { contextTokens: c.tokens, ...(typeof c.window === 'number' && c.window > 0 && { contextWindow: c.window }) }
  } catch {
    return {}
  }
}

function main(flags) {
  const head = tryGit(process.cwd(), 'rev-parse', 'HEAD')
  if (!head.ok) return { status: 'ERROR', message: 'model-ladder needs a git repository with at least one commit. Do the task directly instead, and tell the user.' }
  const root = repoRoot()
  ensureGitExclude(root)
  mkdirSync(runDir(root), { recursive: true })

  // Other active runs are fine; their scopes are compared once the router has one (scripts/claim.mjs).
  const force = clearStaleFlag(flags)
  if (force !== false) clearStale(root, { force: force === true ? null : force })
  const stale = readLocks(root).filter((lock) => lock.stale)
  if (stale.length) {
    return {
      status: 'STALE_RUN',
      message: `A model-ladder run lock looks stale: its process is gone, it is unreadable, or it is an older version's run.json (active or crashed): ${stale.map((lock) => lock.path).join(', ')}`,
      locks: stale.map((lock) => ({ runId: lock.runId, runtime: lock.runtime ?? 'unknown', lock: lock.path })),
    }
  }

  let pluginOptions = {}
  if (flags.has('--plugin-options')) {
    try {
      pluginOptions = JSON.parse(readFileSync(0, 'utf8').trim() || '{}')
    } catch (e) {
      return { status: 'ERROR', message: `The plugin options on stdin are not valid JSON (${e.message}). Escape quotes and line breaks in the values as JSON and run preflight again.` }
    }
  }
  let loaded
  try {
    loaded = loadConfig(root, pluginOptions)
  } catch (e) {
    return { status: 'ERROR', message: e.message }
  }
  if (loaded.problems.length) return { status: 'ERROR', message: `model-ladder settings (${userConfigPath('claude')}, then .claude/model-ladder.json): ${loaded.problems.join('; ')}` }
  const { config } = loaded

  // Before the run marker, so stopping here leaves no state behind. The same live check runs after every attempt.
  const guard = claudeGuard(root)
  if (guardStops(guard)) {
    return { status: 'USAGE_LIMIT', message: `Claude usage is at ${guard.usage}%, at or above the usageGuard threshold of ${guard.threshold}%. Try again after the limit resets.` }
  }

  const overrides = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'].filter((v) => process.env[v])
  if (overrides.length && !flags.has('--ignore-env')) {
    return { status: 'OVERRIDDEN', message: `${overrides.join(' and ')} is set and overrides the ladder's model or effort for every attempt.` }
  }

  // Waits out another run's apply, so its half-written files never look like the user's changes.
  // Changes another run applied earlier and nobody committed are uncommitted changes like any other.
  const dirtyFiles = withMutex(root, 'apply', () => git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.', ...OWN))
    .split('\n').filter(Boolean).map((l) => l.slice(3))
  if (dirtyFiles.length && !flags.has('--allow-dirty')) return { status: 'DIRTY', files: dirtyFiles }

  const protection = { always: [...ALWAYS_PROTECTED, ...config.protected], tests: TEST_PATTERNS }
  const runId = `claude-${randomUUID()}`
  // Claude Code has no process that lives for the whole run, so pid is null: finish removes the lock.
  createLock(root, { runId, runtime: 'claude', pid: null, protected: protection.always, tests: protection.tests })
  const run = runFiles(root, runId)
  mkdirSync(run, { recursive: true })

  try {
    pruneRuns(root, { keepFailed: config.keepFailed })
    let baseTree = git(root, 'rev-parse', 'HEAD^{tree}')
    let setupPatch = null
    let setupFiles = []
    if (dirtyFiles.length) {
      // Snapshot through a temporary index so the user's real index is untouched.
      const env = { ...process.env, GIT_INDEX_FILE: join(run, 'index') }
      const g = (...a) => execGit(root, env, a)
      withMutex(root, 'apply', () => {
        g('read-tree', 'HEAD')
        // Not `add -- . ':!.model-ladder'`: git rejects an exclude pathspec that names an ignored path.
        g('add', '-A')
        // -f: when the run dir is not ignored, `add -A` stages this temporary index while git is still writing it.
        g('rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', '.model-ladder', '.claude/worktrees')
      })
      baseTree = g('write-tree').trim()
      setupPatch = join(run, 'setup.patch')
      writeFileSync(setupPatch, g('diff', '--cached', '--binary', 'HEAD'))
      setupFiles = g('diff', '--cached', '--name-only', 'HEAD').split('\n').filter(Boolean)
    }

    writeFileSync(join(run, 'state.json'), JSON.stringify({ baseTree, before: worktrees(root).map((w) => w.path), config }, null, 2))

    return {
      status: 'READY',
      runId,
      workflowArgs: {
        runId,
        config,
        protection,
        baseCommit: head.out,
        hasVerifySkill: existsSync(join(root, '.claude', 'skills', 'verify', 'SKILL.md')),
        setupPatch,
        setupFiles,
        directThreshold: config.direct_threshold,
        splitMinutes: config.split_minutes,
        ...measuredContext(root),
        skills: { worker: config.worker_skills, verifier: config.verifier_skills },
        // Always passed, guard on or off: the command reads the settings each time, so the person's switch
        // and threshold count at the next check, and a guard that is off never stops the run.
        usageGuard: { command: `node "${dirname(fileURLToPath(import.meta.url))}/usage-guard.mjs" --root "${root}"` },
      },
      ...(guard.enabled && guard.usage === null && {
        usageNote: 'usageGuard is on, but no recent Claude usage was found, so it cannot stop this run. The model-ladder band records usage once Claude Code has answered on a Pro/Max plan; with the band off or on an API key, see the README.',
      }),
    }
  } catch (error) {
    releaseLock(root, runId)
    rmSync(run, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(join(run, 'index'), { force: true })
  }
}

function execGit(cwd, env, args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    print(main(new Set(process.argv.slice(2))))
  } catch (e) {
    print({ status: 'ERROR', message: String(e.stderr ?? e.message) })
  }
}
