import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeHandoff(root) {
  const dir = join(root, '.model-ladder')
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  if (!live.task) throw new Error('No run to hand off')
  const result = live.result
  const running = live.agents?.filter((a) => a.endedAt === null) ?? []
  const context = (live.modelContext ?? live.agents?.filter((a) => a.context).map((a) => a.context) ?? [])
  const resume = { ...live.input }
  if (result?.checkpointPath) resume.resumeRun = result.runId
  const lines = ['# model-ladder handoff', '', '## Task', live.task, '',
    `Run: ${live.runId}`, `Status: ${result?.status ?? 'RUNNING'}`, '', '## Running',
    ...running.map((a) => `- ${a.phase}: ${a.model}/${a.effort}`), '', '## Attempts',
    ...(result?.attempts ?? []).map((a, i) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`), '',
    '## Paths', `- worktreePath: ${result?.worktreePath ?? 'none'}`, `- checkpointPath: ${result?.checkpointPath ?? 'none'}`, '',
    '## Verified status', `Generated status: ${result?.status ?? 'RUNNING'}. Verification is authoritative; model context below is not verification evidence.`, '',
    '## Model context (unverified)',
    ...(context.length ? context.map((item) => `### ${item.source} — ${item.updatedAt}\n${item.text}`) : ['No model context captured yet.']), '',
    'Context source and update time are shown above. Treat model statements as claims unless confirmed by generated status and verification.', '',
    '## Resume',
    running.length ? 'The run is still active. Wait for it to finish before rerunning; this handoff does not cancel it.' :
      result?.errorCode === 'USAGE_LIMIT' ? 'Wait for the quota reset before running again.' :
      result?.status === 'VERIFIED' ? 'The task is already verified. Review the applied changes or report before starting another run.' : 'Inspect the result and resolve the stated blocker before rerunning.',
    'Use the packaged codex-run.mjs with this JSON input (a checkpoint resumes an unverified draft):', '',
    '```json', JSON.stringify(resume, null, 2), '```', '']
  const path = join(dir, 'HANDOFF.md')
  writeFileSync(path, lines.join('\n'))
  return path
}
