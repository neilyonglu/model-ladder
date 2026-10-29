import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactDir } from './common.mjs'

// stopped: why another process force-stopped this run (scripts/usage-guard.mjs forceStopRuns). The run's own process
// was killed before it could record a result, so its unfinished agents are reported as stopped, not running.
export function writeHandoff(root, { stopped = null, live: suppliedLive = null, runId = null } = {}) {
  const dir = join(root, '.model-ladder')
  let live = suppliedLive
  if (!live && runId && /^codex-[0-9a-f-]{36}$/.test(runId)) {
    try { live = JSON.parse(readFileSync(join(artifactDir(root), runId, 'live.json'), 'utf8')) } catch {}
  }
  live ??= JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  if (runId && live.runId !== runId) throw new Error('Shared live state belongs to another run; no matching handoff data')
  if (!live.task) throw new Error('No run to hand off')
  const result = live.result
  const unfinished = live.agents?.filter((a) => a.endedAt === null) ?? []
  const running = stopped ? [] : unfinished
  const status = stopped && !result ? 'USAGE_LIMIT' : result?.status ?? 'RUNNING'
  const context = [
    ...(live.input?.directSummary ? [{ source: 'calling session (DIRECT, unverified)', updatedAt: live.updatedAt, text: live.input.directSummary }] : []),
    ...(live.modelContext ?? live.agents?.filter((a) => a.context).map((a) => a.context) ?? []),
  ]
  const resume = { ...live.input }
  if (result?.checkpointPath) {
    delete resume.directRun
    delete resume.directSummary
    if (result.status === 'DIRECT') resume.directRun = result.runId
    else resume.resumeRun = result.runId
  }
  const lines = ['# model-ladder handoff', '', '## Task', live.task, '',
    `Run: ${live.runId}`, `Status: ${status}`, '',
    ...(stopped ? ['## Stopped', stopped, ...unfinished.map((a) => `- ${a.phase}: ${a.model}/${a.effort} (killed mid-run)`), ''] : []),
    '## Running',
    ...running.map((a) => `- ${a.phase}: ${a.model}/${a.effort}`), '', '## Attempts',
    ...(result?.attempts ?? []).map((a, i) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`), '',
    '## Paths', `- worktreePath: ${result ? result.worktreePath ?? 'none' : live.worktreePath ?? 'none'}`, `- checkpointPath: ${result?.checkpointPath ?? 'none'}`, '',
    '## Verified status', `Generated status: ${status}. Verification is authoritative; model context below is not verification evidence.`, '',
    '## Model context (unverified)',
    ...(context.length ? context.map((item) => `### ${item.source} — ${item.updatedAt}\n${item.text}`) : ['No model context captured yet.']), '',
    'Context source and update time are shown above. Treat model statements as claims unless confirmed by generated status and verification.', '',
    '## Resume',
    running.length ? 'The run is still active. Wait for it to finish before rerunning; this handoff does not cancel it.' :
      result?.status === 'DIRECT' ? 'This is an unverified DIRECT draft. Edit only worktreePath under the reported protection rules, then add directSummary to this JSON and return it for independent verification.' :
      stopped || result?.errorCode === 'USAGE_LIMIT' ? 'Wait for the quota reset before running again.' :
      result?.status === 'VERIFIED' ? 'The task is already verified. Review the applied changes or report before starting another run.' : 'Inspect the result and resolve the stated blocker before rerunning.',
    'Use the packaged codex-run.mjs with this JSON input (a checkpoint resumes an unverified draft). A force-stopped process may have no checkpoint; inspect its retained draft before restarting the original input:', '',
    '```json', JSON.stringify(resume, null, 2), '```', '']
  const path = join(dir, 'HANDOFF.md')
  writeFileSync(path, lines.join('\n'))
  return path
}
