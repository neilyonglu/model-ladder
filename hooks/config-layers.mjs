// Settings come in layers, later ones winning key by key:
//   1. built-in defaults
//   2. the user's own file: ~/.claude/model-ladder.json (Claude Code) or ~/.codex/model-ladder.json (Codex),
//      personal habits such as usageGuard that never go into a committed project file
//   3. the project's file: .claude/model-ladder.json or .codex/model-ladder.json, committed with the repo
// usageGuard merges field by field, so a layer that sets only a threshold keeps the on/off choice beneath it.
// Pure on purpose (no Node imports): the band (hooks/band/register.tsx) imports it too and reads files through $.fs.

export const CONFIG_FILE = 'model-ladder.json'
export const GUARD_DEFAULT = { enabled: true, threshold: 90 }

export function mergeConfig(defaults, user = {}, project = {}) {
  return { ...defaults, ...user, ...project, usageGuard: { ...defaults.usageGuard, ...user.usageGuard, ...project.usageGuard } }
}

// MODEL_LADDER_USER_CONFIG names the file outright (tests use it); otherwise CLAUDE_CONFIG_DIR or CODEX_HOME
// replaces the home folder, as Claude Code and Codex themselves do.
export function userConfigPath(runtime, env, home) {
  if (env.MODEL_LADDER_USER_CONFIG) return env.MODEL_LADDER_USER_CONFIG
  const dir = runtime === 'codex' ? env.CODEX_HOME || `${home}/.codex` : env.CLAUDE_CONFIG_DIR || `${home}/.claude`
  return `${dir}/${CONFIG_FILE}`
}

// Claude Code leaves a plugin option it did not fill in as the literal "${user_config.x}": that is unset.
export const resolved = (value) => (typeof value === 'string' && !value.includes('${') ? value : undefined)

// The plugin's worker_skills / verifier_skills / direct_threshold / split_minutes options are the user's defaults for every project. They join the
// user layer, so a project file with the same key (even an empty one) wins.
export function pluginLayer(options = {}) {
  const layer = {}
  const direct = resolved(options.direct_threshold)
  if (direct !== undefined) layer.direct_threshold = /^\d+(?:\.\d+)?$/.test(direct) ? Number(direct) : direct
  const split = resolved(options.split_minutes)
  if (split !== undefined) layer.split_minutes = /^\d+(?:\.\d+)?$/.test(split) ? Number(split) : split
  for (const key of ['worker_skills', 'verifier_skills']) {
    const value = resolved(options[key])
    if (value !== undefined) layer[key] = value
  }
  return layer
}

// The only edits anything makes to usageGuard, each one a person's explicit action (band switch or threshold,
// watch.mjs g / t / --guard / --threshold). Each changes one field of the user's file and keeps the rest.
export const setGuard = (user, patch) => ({ ...user, usageGuard: { ...user.usageGuard, ...patch } })

// A threshold typed by a person: "85", "85%" or " 85 " -> 85; anything outside 1-100 -> null.
export function parseThreshold(text) {
  const value = String(text).trim().replace(/%$/, '')
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= 100 ? n : null
}

// The project file can still pin a usageGuard field (older setups do); then a change in the user's file has no
// effect in this project, and the person is told why instead of the project file being rewritten.
export const projectPins = (project, field) => project?.usageGuard?.[field] !== undefined
