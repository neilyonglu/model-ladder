# Safety and recovery

The runner asks before using existing dirty changes, protects verification
inputs, and retains recoverable state when a run cannot finish.

## Sub-features

- `safety-dirty` requires consent and preserves the real index.
- `safety-protection` rejects source/test tampering during verification.
- `recovery-quota` stops at the usage threshold and writes a handoff.
- `recovery-timeout` preserves and validates checkpoints before resuming.

## How to get to it (user POV)

- Submit a task in a dirty checkout to receive DIRTY and the changed-file list.
- Enable the usage guard or encounter a timeout during a Codex run.
- Resume with the reported `resumeRun` after resolving the stated blocker.

## Driving it with Node

Preconditions: doctor passes. Never force a timeout or quota stop in a user's
active run. Existing fixture scenarios isolate Codex home and rate-limit data.

- Run `node --test tests/unit/*.test.mjs`. The Codex integration tests
  submit fixture tasks and assert DIRTY has no model calls, unverified edits
  stay unapplied, checkpoints retain the draft, mismatches refuse resume, quota
  handoff exists, and owned markers/worktrees are released appropriately.
- Claude workflow and finish tests separately cover quota stops and retained
  worktree pointers. Require exit code 0 and keep the suite transcript.

## Gotchas

- Never disable the user's real usage guard to make verification pass.
- A retained checkpoint is an unverified draft, not successful completion.
- Fake scenarios prove control flow, not accuracy of model-authored summaries.
