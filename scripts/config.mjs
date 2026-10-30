// Reads and writes the layered settings (see hooks/config-layers.mjs) for preflight, the usage guard check,
// the Codex runner and watch.mjs. The band does the same through $.fs with the same pure helpers.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, mergeConfig, pluginLayer, projectSkills, setGuard, userConfigPath as pathFor } from '../hooks/config-layers.mjs'
import { atomicJson } from './codex-live.mjs'
import { worktrees } from './common.mjs'

export const userConfigPath = (runtime, env = process.env) => pathFor(runtime, env, homedir())
export const projectConfigPath = (root, runtime) => join(root, runtime === 'codex' ? '.codex' : '.claude', CONFIG_FILE)

function readJson(path) {
  if (!existsSync(path)) return {}
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must hold a JSON object`)
  return value
}

export function readLayers(root, runtime) {
  return { user: readJson(userConfigPath(runtime)), project: readJson(projectConfigPath(root, runtime)) }
}

// defaults -> user file (+ Claude Code plugin options) -> project file. Read fresh on every call.
export function loadLayered(root, runtime, defaults, pluginOptions = {}) {
  const { user, project } = readLayers(root, runtime)
  const config = mergeConfig(defaults, { ...user, ...pluginLayer(pluginOptions) }, project)
  let projectRoot = root
  if (['worker_skills', 'verifier_skills'].some((key) => typeof config[key] === 'string' && config[key].includes(':'))) {
    try { projectRoot = worktrees(root)[0]?.path ?? root } catch { /* not a Git repository */ }
  }
  return projectSkills(config, projectRoot)
}

// A person's explicit guard change: one field of the user's file, nothing else, never the project file.
export function writeUserGuard(runtime, patch) {
  const path = userConfigPath(runtime)
  atomicJson(path, setGuard(readJson(path), patch))
  return path
}
