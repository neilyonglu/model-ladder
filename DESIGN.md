# model-ladder design

[README](README.md) · [Advanced usage](USAGE.md) · [繁體中文](DESIGN.zh-TW.md)

## Goals

Select a suitable model and effort, verify independently, preserve existing work, and apply only verified changes.
Claude Code uses a Workflow; Codex uses a standalone Node runner.

## Modules

| Module | Responsibility |
|---|---|
| `skills/run/` | Claude preflight, routing, questions, workflow, and finish. |
| `codex-skills/model-ladder/` | Codex runner setup and result handling. |
| `workflows/ladder.js` | Claude orchestration and canonical escalation rules. |
| `scripts/preflight.mjs`, `claim.mjs`, `finish.mjs` | Validate, snapshot, claim scope, apply, and clean up. |
| `scripts/codex-run.mjs` | Codex route, attempts, verification, diagnosis, and application. |
| `scripts/codex-exec.mjs`, `codex-worktree.mjs` | Child processes, schemas, and worktree safety. |
| `scripts/runs.mjs` | Shared locks, scope checks, and apply mutex. |
| `hooks/config-layers.mjs`, `scripts/config.mjs` | Shared settings merge and Node file access. |
| `hooks/guard.mjs` | Early protection of worker edits. |
| `scripts/usage-guard.mjs` | Usage checks and registered runner termination. |
| `hooks/band/`, `scripts/watch.mjs`, `codex-hud.mjs` | Claude band and Codex terminal displays. |
| `scripts/sync-rules.mjs` | Generate `scripts/ladder-rules.mjs` from the workflow's pure rules. |

## Roles and flow

| Role | Responsibility and boundary |
|---|---|
| Router | Select the starting cell, scope, verification, and legal next move. |
| Worker | Implement one attempt in an isolated worktree without changing protected inputs. |
| Test-writer | Handle explicitly requested test changes under the same worker restrictions. |
| Verifier | Independently check the diff and acceptance criteria without fixing code. |
| Main session | Handle questions, DIRECT work, summaries, and handoff context. |

Claude Router has Read, Grep, and Glob; workers and verifiers inherit available tools except Workflow and Agent, with verifier writes forbidden.
Codex role processes use explicit models, schemas, persisted rollouts for usage sampling, and the existing sandbox and approval controls.

```text
validate -> snapshot -> route -> claim scope -> worker -> verifier -> apply
                                                 ^          |
                                                 +-- diagnose failure
```

- Claude uses `preflight.mjs`, a routing Workflow call, `claim.mjs`, the execution Workflow call, then `finish.mjs`.
- Codex owns the same stages inside `codex-run.mjs`.
- Existing checks or explicit user acceptance are required; the router must not invent a check or approval.
- Test changes require a user request, and only verified results reach the checkout.
- Normal retries start from the original snapshot with prior summaries and hints rather than failed code.

## Settings and instructions

Settings resolve as defaults, personal file, then project file, with `usageGuard` merged per field.
Personal files are `~/.claude/model-ladder.json` and `~/.codex/model-ladder.json`; full options are in [advanced settings](USAGE.md#advanced-settings).
Claude plugin `worker_skills` and `verifier_skills` values join the personal layer; project values override them, including empty strings.

Shared `projectSkills` filtering selects exact main-repo folder prefixes after merging, retains unprefixed global lines, and strips only the first colon prefix before execution and display.
Selected instructions retain their bodies and role restrictions; availability checks and final reports include only applicable capability blockers.
Only explicit user actions change `usageGuard.enabled`; threshold edits preserve the switch and write only the personal field.
Project overrides remain effective, and guard changes do not invalidate Codex resume checkpoints.

## Escalation

| Move | Rule |
|---|---|
| Higher effort | Same tier, limited by `maxEffortJump`. |
| Stronger model | Next tier only, at any allowed effort. |
| Invalid router choice | Next effort, otherwise the lowest effort in the next tier. |
| Environment or unclear task | Stop and report the blocker. |

`legalMoves` and `pickMove` come from the generated shared rules, with drift checked by tests.
A dead worker or invalid output fails that step; failed diagnosis uses the default legal move.
Authentication, model-access, and sandbox errors stop Codex rather than triggering escalation.

## Isolation and concurrent runs

| Mechanism | Guarantee |
|---|---|
| Temporary Git index | Snapshot committed, dirty, and untracked input without altering the user's index. |
| `baseTree` diff | Apply only attempt changes, preserving the original snapshot. |
| Per-run lock | Record run ID, runtime, process, protection, and claimed scope. |
| Scope registry mutex | Prevent overlapping claims from passing together. |
| Apply mutex | Serialize application, commits, dirty checks, and snapshots. |
| Conflict result | Keep the patch and worktree when application no longer succeeds. |
| Owned-worktree cleanup | Remove only this run's artifacts and preserve retained drafts. |

Scopes use conservative normalized path prefixes; empty, invalid, or wildcard-only scopes cover the whole repo.
Read-only runs do not claim an editing scope, and unclaimed runs are compared when they claim.
A dead process or unreadable lock is stale; Claude locks use no persistent PID and require confirmed cleanup after a crash.
Never clear a live process lock or another active run's worktree.
Shared `live.json`, panel state, and `HANDOFF.md` remain last-writer-wins; Codex keeps per-run live snapshots for quota handoffs.

## Protected inputs

| Layer | Check |
|---|---|
| Claude PreToolUse hook | Block protected worker edits early when a run lock exists. |
| Verifier diff | Check actual tracked and untracked changes, including shell edits. |
| Codex verification | Protect config, tests, selected verification skills, npm scripts/config, and relevant build manifests. |

Tests remain protected unless the task requests test changes; explicit `protected` paths remain forbidden.
Verification may create build artifacts, but existing tracked inputs remain checked.
The hook is best effort and fails open if Node is unavailable; final diff checks still enforce protection.

## DIRECT, splitting, and recovery

| Feature | Rule |
|---|---|
| DIRECT | Small task plus measured context at `direct_threshold`; never verified by the routing decision alone. |
| Claude DIRECT | Main session edits, then a separate verifier checks, with at most three correction rounds. |
| Codex DIRECT | Caller edits an isolated draft, then `directRun` reclaims scope, checks the baseline, verifies, and applies. |
| Forecast | Duration ranges, observed phase timings and per-window headroom; elapsed/expected in the panel; one usage-risk confirmation before the worker when a window is insufficient or at risk; no split confirmation. |
| Force ladder | `forceLadder` disables DIRECT and split suggestions. |
| Timeout | Idle time without output, configured by `timeoutMs`. |
| Codex resume | Validate checkout, task, acceptance, and configuration before continuing a draft in a fresh worktree. |

The Codex skill automatically resumes a timeout at most twice, but never automatically resumes a quota stop or cancellation.
No automatic Codex context source is assumed, and unavailable draft access never permits a sandbox bypass.
Optional commits exclude unrelated staged changes and skip affected files with pre-existing or concurrent edits; no run pushes.

## Usage stops and handoff

- Claude checks before a run and after failed attempts; Codex checks role boundaries and polls every 2 seconds.
- Hard quota errors and recognized limit-only responses stop as `USAGE_LIMIT`, independently of the guard switch.
- An active usage stop also terminates other registered runner process trees on the machine.
- Windows termination failures retain registration and report the blocker without a false stopped handoff.
- Registered process control does not imply an API for cancelling arbitrary hosted Claude agents.
- Force-killed drafts may lack a checkpoint, so `resumeRun` must never be invented.

`/model-ladder:handoff` and automatic quota handoffs write `.model-ladder/HANDOFF.md`.
The main session adds conversation context above the unchanged generated verification appendix, which stays authoritative.
If no model call is possible, retain the template; manual handoff does not cancel work.

## Storage, display, and platform limits

| Area | Behavior |
|---|---|
| Claude run files | Locks and transient state live under `.model-ladder/runs/`. |
| Codex artifacts | `artifactDir(root)` places worktrees, logs, checkpoints, and results in system temp under `model-ladder/<repo hash>/`. |
| Shared records | `.model-ladder/` stores history, live state, usage, context, and handoff. |
| Cleanup | Preserve active runs, conflicts, retained patches, checkpoints, and unfinished drafts. |
| Autorun | SessionStart instruction subject to user/project rules, with trusted hooks required in Codex. |
| Internal roles | Disable recursive autorun and panel setup. |
| Claude band | Event-driven rows, context measurement, guard controls, and handoff. |
| Codex display | Terminal panel or HUD, without native Claude UI or automatic context metrics. |

Role processes cannot inherit private parent conversation context or tools unavailable in the child host.
Display rows refresh each second and remain visible for 10 seconds after completion.

## Verification and releases

- Run only tests related to a local change; CI runs `node --test tests/unit/*.test.mjs`.
- Offline harnesses use temporary Git repos and fake model boundaries, proving control flow rather than authentication, model quality, or hosted UI.
- Real-account checks are separate: `tests/e2e/codex-smoke.mjs` and `tests/e2e/run.mjs`.
- `scripts/update-check.mjs` caches version checks daily and fails silently; `MODEL_LADDER_NO_UPDATE_CHECK=1` disables them.
- Keep plugin identities and versions aligned, update both changelogs, and tag releases as `vX.Y.Z`.
- CI requires a version bump for plugin changes after the latest release tag; docs-only changes do not need one.
