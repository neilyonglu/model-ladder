# Panel and handoff

Users watch roles and usage, adjust the guard, and save a handoff without
cancelling the current run.

## Sub-features

- `panel-live` updates running time and removes completed rows after ten seconds.
- `panel-controls` persists guard and threshold changes.
- `panel-handoff` records active state and quota-stop resume inputs.
- `band-instructions` filters project rules and expands/collapses instruction text without a label prefix.

## How to get to it (user POV)

- Run `node scripts/watch.mjs --cwd <repository>` in a terminal.
- Enter `g`, `t 90`, or `h`, followed by Enter; enter `q` to close the watcher.
- Run `node scripts/watch.mjs --cwd <repository> --handoff` for CLI handoff.
- Claude's band provides guard controls and a `handoff now` button.
- Set `worker_skills` or `verifier_skills` to `repo-folder: instruction`; unprefixed lines remain global, and the instruction arrow toggles the Band preview.

## Driving it with Node

Preconditions: doctor passes. Use the harness's disposable repo, not a user's
active panel. The fake model boundary requires no account or network.

- Run `node .agents/skills/verify/verify.mjs panel`. It launches the real watcher,
  runs a fixture task, observes changing elapsed seconds and eventual idle rows,
  and stops the watcher. Require `PASS: VERIFIED` and exit code 0.
- Run `node .agents/skills/verify/verify.mjs handoff` for the CLI entry point.
  It seeds isolated persisted active/stopped state, invokes the real CLI, reads
  HANDOFF.md, asserts its warnings and parsed resume JSON, then removes only its
  fixture. Both generated handoffs survive in the evidence directory.
- Run `node --test tests/unit/*.test.mjs` for panel control and handoff
  journeys. Existing tests check persisted settings, rejected thresholds without
  writes, active-run warnings, and the saved `resumeRun` and `allowDirty` JSON.
- Retain stdout/stderr and result metadata after harness cleanup. A handoff
  change must additionally be observed in the generated HANDOFF.md content.
- Run `claude plugin test .` for native Band instruction matching, visibility, and disclosure presses on terminal, Desktop, and VS Code trees; it uses no account or network.

## Gotchas

- `--guard` and `--threshold` write personal configuration; use isolated test settings.
- The smoke captures a noninteractive watcher stream, not PTY keyboard input.
- Windows signal killing can produce a null exit code instead of invoking the
  watcher's signal handler. The harness must request portable graceful shutdown
  and still require exit code 0. CLI handoff proof does not cover this lifecycle.
- Offline tests exercise the command dispatcher, not actual terminal keypresses
  or Claude's band button. Host UI entry points remain separate checks.
