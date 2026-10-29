// Claude Code usage guard, read live: the settings as they are now (user file, then project file) and the
// subscription usage now. preflight calls it before a run; the workflow's verifier runs it after every attempt
// (`node usage-guard.mjs --root <repo>`), so turning the guard off or on, or changing the threshold, mid-run
// counts at the next check. Prints one JSON line: {"enabled":true,"threshold":90,"usage":42}
// usage is null when unknown; "error" is set when the settings cannot be read. Only enabled with a known usage at
// or above the threshold stops a run.
import { pathToFileURL } from 'node:url'
import { GUARD_DEFAULT } from '../hooks/config-layers.mjs'
import { loadLayered } from './config.mjs'
import { projectUsageFile, readClaudeUsage } from './usage-statusline.mjs'

export function claudeGuard(root) {
  let guard
  try {
    guard = loadLayered(root, 'claude', { usageGuard: GUARD_DEFAULT }).usageGuard
  } catch (e) {
    return { enabled: false, threshold: null, usage: null, error: e.message }
  }
  const usage = guard.enabled === true ? readClaudeUsage(projectUsageFile(root)) ?? readClaudeUsage() : null
  return { enabled: guard.enabled === true, threshold: guard.threshold, usage }
}

export const guardStops = (state) => state.enabled && typeof state.usage === 'number' && typeof state.threshold === 'number' && state.usage >= state.threshold

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--root')
  console.log(JSON.stringify(claudeGuard(at > 0 ? process.argv[at + 1] : process.cwd())))
}
