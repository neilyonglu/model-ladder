# Run and verify a task

A user submits a task and receives a verified change, a report, or an explicit
blocker. Failed attempts can retry without applying an unverified draft.

## Sub-features

- `run-first-pass` applies a verified change and preserves the user's index.
- `run-retry` escalates after a failed attempt.
- `run-report` returns a read-only deliverable.
- `run-claude` exercises the Claude workflow separately from Codex.

## How to get to it (user POV)

- Codex invokes the packaged `codex-run.mjs --input <UTF-8 JSON file>`.
- Claude invokes `/model-ladder:run <task>`.

## Driving it with Node

Preconditions: doctor passes; no live model credentials are needed offline.

- Run `node --test tests/unit/*.test.mjs`. Existing Codex integration
  harnesses submit fixture tasks through `runLadder`, assert verified file
  contents, unchanged index, retry results, and cleaned worktrees. Claude
  `flow.test.mjs` and `scripts.test.mjs` exercise workflow and finish behavior.
- Require exit code 0 and inspect the suite log. Unit/integration entry points
  do not prove installed plugin dispatch in a real host.
- Optionally run `node tests/e2e/codex-smoke.mjs` for real model execution; save
  its JSON and stderr separately. Require VERIFIED and corrected fixture content.

## Gotchas

- The real-model smoke consumes quota and needs supported models and auth.
- Claude's headless e2e runner needs Claude and Python/uv; it is not covered by
  the offline Node suite. Do not claim host-level Claude verification.
- Do not invoke a fixture typo task against the user's checkout.
