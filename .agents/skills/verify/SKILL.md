---
name: verify
description: Verify model-ladder CLI runs, terminal panel, handoff, and safety controls with the existing offline Node harnesses. Use after runner, workflow, hook, or handoff changes.
---

# Verify model-ladder

## Launch

Run from the repository root with Node 20+ and Git on PATH. No npm install,
server, database, or build is needed. Read `features/README.md` first.

```sh
node .agents/skills/verify/verify.mjs doctor
```

The CLI's `--help` output is the launch readiness check. Continue with the
offline suite and handoff CLI journey in Drive. Require exit code 0 for every
command. Each harness creates its own disposable repository.
The smoke harness starts and stops its own watcher; do not drive the user's
running watcher or invoke the production runner against this checkout.

## Doctor

```sh
node .agents/skills/verify/verify.mjs doctor
```

Checks Node, Git, both CLI help screens, plugin version parity, and generated
rules without changing source or running a model. Doctor writes only evidence.
If Git cannot create fixture worktrees during later checks, report the sandbox
restriction and use the normal approval mechanism. Never add bypass flags.

## Drive

```sh
node --test tests/unit/*.test.mjs
node .agents/skills/verify/verify.mjs handoff
node .agents/skills/verify/verify.mjs panel
```

Run the README's offline suite directly, including the existing Codex runner
integration tests and Claude workflow tests. Preserve its terminal transcript
and exit code. It can run for several minutes; poll a yielded process session
until completion instead of launching another suite. Earlier attempts to nest
this suite in a synchronous wrapper stalled under the verifier, so this helper
does not wrap the suite. `handoff` invokes the real
`watch.mjs --handoff` CLI with active and quota-stopped persisted fixtures,
asserts the warning and parsed resume JSON, and preserves both generated files.
`panel` separately runs
`node tests/e2e/codex-live-smoke.mjs`, which drives a real watcher and real Git
worktrees using the existing fake-Codex executable at the model-process boundary.
Require the harness's `PASS: VERIFIED` message and exit code 0.
Run `panel` when changing watcher or display behavior and require a normal
exit code of 0. On Windows, killing a child with `SIGINT` can force termination
instead of delivering Node's signal event. Use the harness's portable shutdown
path; never treat a null exit code as success or waive the lifecycle check.

For a focused feature, use the exact command in its map entry. Capture command,
stdout, stderr, exit status, and observable file effects. Passing old tests alone
does not prove a new requirement. Inspect the actual diff and exercise the new
behavior too, using an existing harness when possible. If its preconditions are
missing, report that journey as blocked rather than replacing it with a weaker one.

## Evidence

The helper prints its unique `artifactDir/verification/<run-id>/` directory (system temp, `os.tmpdir()/model-ladder/<repo hash>/`).
Each child command gets `.stdout.txt` and `.stderr.txt` files. `result.json`
records commands, working directory, revision, times, exit codes, and failures.
Require `passed: true`; inspect failure logs instead of relying on the summary.
Record additional focused-command evidence there as needed.

Offline proof covers application behavior with a fake model boundary. It does
not prove authentication, model availability, model answer quality, or Claude's
hosted band UI. For a real Codex boundary check, the existing command is
`node tests/e2e/codex-smoke.mjs`; it uses account quota and live authentication.
It is optional and must be reported separately. It may retain a failed fixture
at the path printed in its JSON. Do not claim it ran from offline evidence.
The Claude `tests/e2e/run.mjs --dry` path also requires Python/uv and creates
fixtures; it is not part of this Node-only baseline or proof of live Claude.

## Cleanup

The existing offline harnesses remove their own disposable repositories and
stop their own watcher in cleanup. A CLI command completing requires no server
teardown. Never kill by process name or delete another run's worktree. If an
interrupted harness retains scratch state, inspect its printed path and process
ownership before removing it. Keep the `artifactDir/verification/` evidence after
cleanup and confirm the printed `result.json` still exists.
When a caller will remove the entire verification worktree, have that caller
copy the evidence to the owning checkout before removal. Worktree-local proof
alone does not survive that cleanup.

## Helpers

`node .agents/skills/verify/verify.mjs [doctor|handoff|panel]` is the executable
helper; omitted mode means `handoff`. It reuses existing checks, adds no dependency,
and returns nonzero on the first failure. Do not invoke model-ladder recursively
from this verification skill. Use pstack's `maintain-verification-skill` when
entry points or observable behavior change.
