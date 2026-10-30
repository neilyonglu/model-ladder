// Claims the router's scope for a Claude Code run, between routing and the attempts.
// stdin: JSON { "runId": "<from preflight>", "scope": [...plan.scope], "readOnly": <plan.readOnly> }
// Prints a status:
//   READY        no active run's scope overlaps; call the workflow with the plan
//   NEEDS_INPUT  overlaps an active run (overlaps) -> ask: wait and claim again, or stop
//   STALE_RUN    overlaps a stale lock (overlaps)  -> ask; rerun with --clear-stale
//   ERROR        message
// --clear-stale=<runId> also clears that run's lock (a Claude Code run whose session is gone).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { print, repoRoot } from './common.mjs'
import { claimScope, clearStaleFlag } from './runs.mjs'
import { setPhase } from './phase.mjs'

export function main(input, flags) {
  if (typeof input?.runId !== 'string' || !input.runId) return { status: 'ERROR', message: 'input needs runId, the runId preflight printed' }
  if (!input.readOnly && !Array.isArray(input.scope)) return { status: 'ERROR', message: "input needs scope, the plan's scope list" }
  const force = clearStaleFlag(flags)
  const root = repoRoot()
  const out = claimScope(root, input.runId, { scope: input.scope, readOnly: input.readOnly === true, clear: force !== false, force: typeof force === 'string' ? force : null })
  // The band's main-session row shows the phase; a failed phase write never fails the claim.
  if (out.status === 'READY') { try { setPhase(root, input.runId, 'claimed') } catch {} }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    print(main(JSON.parse(readFileSync(0, 'utf8')), new Set(process.argv.slice(2))))
  } catch (e) {
    print({ status: 'ERROR', message: String(e.stderr ?? e.message) })
  }
}
