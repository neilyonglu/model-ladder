// Checks the repo, snapshots uncommitted work, writes the run marker, and prints the
// workflow args as JSON. Stops at the first thing the user must decide, as a status:
//   ERROR       not runnable (message)
//   STALE_RUN   a run marker exists          -> ask; rerun with --clear-stale
//   OVERRIDDEN  env vars override the ladder -> ask; rerun with --ignore-env
//   DIRTY       uncommitted changes (files)  -> ask; rerun with --allow-dirty
//   USAGE_LIMIT usageGuard is on and the subscription usage is at the threshold -> stop
//   READY       workflowArgs to pass to the model-ladder:ladder workflow
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALWAYS_PROTECTED, TEST_PATTERNS } from '../hooks/guard.mjs'
import { git, print, repoRoot, runDir, tryGit, worktrees } from './common.mjs'
import { readClaudeUsage } from './usage-statusline.mjs'

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
  usageGuard: { enabled: false, threshold: 90 },
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const OWN = [':!.claude/worktrees', ':!.model-ladder']

export function loadConfig(root) {
  const path = join(root, '.claude', 'model-ladder.json')
  const user = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const config = { ...DEFAULTS, ...user, usageGuard: { ...DEFAULTS.usageGuard, ...user.usageGuard } }
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
  return { config, problems }
}

function main(flags) {
  const head = tryGit(process.cwd(), 'rev-parse', 'HEAD')
  if (!head.ok) return { status: 'ERROR', message: 'model-ladder needs a git repository with at least one commit.' }
  const root = repoRoot()
  const run = runDir(root)
  mkdirSync(run, { recursive: true })
  const marker = join(run, 'run.json')

  if (existsSync(marker)) {
    if (!flags.has('--clear-stale')) return { status: 'STALE_RUN', message: 'A model-ladder run marker exists: another run is active, or a previous one crashed.' }
    rmSync(marker)
  }

  let loaded
  try {
    loaded = loadConfig(root)
  } catch (e) {
    return { status: 'ERROR', message: `.claude/model-ladder.json is not valid JSON: ${e.message}` }
  }
  if (loaded.problems.length) return { status: 'ERROR', message: `.claude/model-ladder.json: ${loaded.problems.join('; ')}` }
  const { config } = loaded

  // Before the run marker, so stopping here leaves no state behind.
  const guard = config.usageGuard
  const usage = guard.enabled ? readClaudeUsage() : null
  if (usage !== null && usage >= guard.threshold) {
    return { status: 'USAGE_LIMIT', message: `Claude usage is at ${usage}%, at or above the usageGuard threshold of ${guard.threshold}%. Try again after the limit resets.` }
  }

  const overrides = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'].filter((v) => process.env[v])
  if (overrides.length && !flags.has('--ignore-env')) {
    return { status: 'OVERRIDDEN', message: `${overrides.join(' and ')} is set and overrides the ladder's model or effort for every attempt.` }
  }

  const dirtyFiles = git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.', ...OWN)
    .split('\n').filter(Boolean).map((l) => l.slice(3))
  if (dirtyFiles.length && !flags.has('--allow-dirty')) return { status: 'DIRTY', files: dirtyFiles }

  const protection = { always: [...ALWAYS_PROTECTED, ...config.protected], tests: TEST_PATTERNS }
  writeFileSync(marker, JSON.stringify({ protected: protection.always, tests: protection.tests }), { flag: 'wx' })

  try {
    let baseTree = git(root, 'rev-parse', 'HEAD^{tree}')
    let setupPatch = null
    let setupFiles = []
    if (dirtyFiles.length) {
      // Snapshot through a temporary index so the user's real index is untouched.
      const env = { ...process.env, GIT_INDEX_FILE: join(run, 'index') }
      const g = (...a) => execGit(root, env, a)
      g('read-tree', 'HEAD')
      // Not `add -- . ':!.model-ladder'`: git rejects an exclude pathspec that names an ignored path.
      g('add', '-A')
      // -f: when the run dir is not ignored, `add -A` stages this temporary index while git is still writing it.
      g('rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', '.model-ladder', '.claude/worktrees')
      baseTree = g('write-tree').trim()
      setupPatch = join(run, 'setup.patch')
      writeFileSync(setupPatch, g('diff', '--cached', '--binary', 'HEAD'))
      setupFiles = g('diff', '--cached', '--name-only', 'HEAD').split('\n').filter(Boolean)
    }

    writeFileSync(join(run, 'state.json'), JSON.stringify({ baseTree, before: worktrees(root).map((w) => w.path), config }, null, 2))

    return {
      status: 'READY',
      workflowArgs: {
        config,
        protection,
        baseCommit: head.out,
        hasVerifySkill: existsSync(join(root, '.claude', 'skills', 'verify', 'SKILL.md')),
        setupPatch,
        setupFiles,
        ...(guard.enabled && {
          usageGuard: { threshold: guard.threshold, command: `node "${dirname(fileURLToPath(import.meta.url))}/usage-statusline.mjs" --percent` },
        }),
      },
      ...(guard.enabled && usage === null && {
        usageNote: 'usageGuard is on, but no recent Claude usage was found. Until the model-ladder statusline script is set up (see the README), the guard will not take effect.',
      }),
    }
  } catch (error) {
    rmSync(marker, { force: true })
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
