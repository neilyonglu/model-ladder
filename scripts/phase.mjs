// Records where a Claude Code run's main session is, in its lock (.model-ladder/runs/<runId>.json), for the band's
// main-session row between ladder agents.
// Usage: node phase.mjs <runId> <phase>
//   needs-input      the main session is asking the user a question
//   awaiting-finish  the workflow returned; the main session checks the result and runs finish
// preflight writes 'preflight' and claim.mjs 'claimed'. Prints { status: "OK", phase } or { status: "ERROR", message }.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { print, repoRoot } from './common.mjs'
import { createLock, lockPath, withMutex } from './runs.mjs'

export const PHASES = ['preflight', 'claimed', 'needs-input', 'awaiting-finish']

// Under the registry mutex, like a claim, so a phase and a scope written at once both stay.
export function setPhase(root, runId, phase) {
  if (!/^[\w-]+$/.test(runId ?? '')) return { status: 'ERROR', message: 'runId must be the runId preflight printed' }
  if (!PHASES.includes(phase)) return { status: 'ERROR', message: `phase must be one of ${PHASES.join(', ')}` }
  return withMutex(root, 'registry', () => {
    let lock
    try { lock = JSON.parse(readFileSync(lockPath(root, runId), 'utf8')) } catch {
      return { status: 'ERROR', message: `The lock for run ${runId} is gone or unreadable.` }
    }
    createLock(root, { ...lock, runId, phase })
    return { status: 'OK', phase }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [runId, phase] = process.argv.slice(2)
    print(runId ? setPhase(repoRoot(), runId, phase) : { status: 'ERROR', message: 'usage: phase.mjs <runId> <phase>' })
  } catch (e) {
    print({ status: 'ERROR', message: String(e.stderr ?? e.message) })
  }
}
