# Advanced usage

[README](README.md#how-to-use) · [繁體中文](USAGE.zh-TW.md) · [Design](DESIGN.md)

## Reports

Reports summarize the task, attempts, changed files, verification, and remaining limits in your session language.

| Result | Meaning |
|---|---|
| `VERIFIED` | Verification passed; editing tasks apply the verified change. |
| `DIRECT` | An unverified draft needs caller work and independent verification. |
| `DIRTY` | Confirm whether to build on existing uncommitted changes. |
| `NEEDS_INPUT` | Clarify the task, approve criteria, choose a split, or resolve an overlap. |
| `STALE_RUN` | Inspect the listed locks and processes before authorizing cleanup. |
| `CONFLICT` | The patch could not apply; inspect the retained patch and worktree. |
| `STOPPED` / `FAILED` / `ERROR` | Read the reason and resolve the blocker before retrying. |

Claude quota stops return `USAGE_LIMIT`; Codex returns `STOPPED` with `errorCode: "USAGE_LIMIT"`.
Run history is stored in `.model-ladder/history.jsonl`.

Without an existing verify command or skill, supply explicit acceptance criteria or use `create-verification-skill` and `maintain-verification-skill`.
Claude generates `.claude/skills/verify/`; Codex generates `.agents/skills/verify/` and also accepts the Claude path.
The generators are adapted from pstack under MIT; see [NOTICE.md](NOTICE.md).

## Codex runner and HUD

| Goal | Command |
|---|---|
| Run a task | `node scripts/codex-run.mjs "<task>"` |
| Supply JSON input | `node scripts/codex-run.mjs --input <file>` |
| Open a panel | `node scripts/watch.mjs --cwd <repo>` |
| Start a CLI HUD | `npm ci`, then `node scripts/codex-hud.mjs --cwd <repo>` |
| Resume with the HUD | Add `-- resume` to the HUD command. |

Only `VERIFIED` exits with code 0; `DIRECT`, `DIRTY`, `NEEDS_INPUT`, and `STALE_RUN` exit 2, and other results exit 1.
Input also accepts JSON on stdin; on Windows, use a UTF-8 input file in the system temp directory.

Reuse the panel across tasks; without a visible terminal, read runner progress in tool output.
The HUD must launch Codex and cannot attach to an existing session.
Windows requires native `codex.exe`, selected through PATH or `CODEX_BINARY`, rather than a `.cmd` or `.bat` shim.

## Concurrent runs

| Situation | Behavior or action |
|---|---|
| Separate file scopes | Runs may proceed together across both runtimes. |
| Overlap | `NEEDS_INPUT` with `reason: "OVERLAP"`; wait for the other run, then retry. |
| Empty, wildcard-only, or out-of-repo scope | Counts as the whole repository. |
| Patch conflicts despite scope checks | Keep the patch and worktree for review. |
| Another run left uncommitted changes | Confirm `DIRTY` before building on its snapshot. |
| Dead, unreadable, or legacy lock | Inspect it, then authorize `--clear-stale` or `clearStale: true`. |
| Crashed Claude session | Clear its confirmed inactive run ID with `--clear-stale=<runId>` or `clearStale: "<runId>"`. |

Never clear a lock with a live process; Claude locks have no persistent process ID and remain active until finish or confirmed cleanup.
Results apply one run at a time; guards protect all active scopes.
Shared `live.json`, the panel, and `HANDOFF.md` show the last writer, while automatic Codex quota handoffs use per-run live state.

## Run files

| Location | Contents |
|---|---|
| `.model-ladder/runs/` | Run locks and Claude transient state, setup patches, and conflict patches. |
| `.model-ladder/` | Shared history, live state, usage, context, and `HANDOFF.md`. |
| `<system temp>/model-ladder/<repo hash>/codex-<uuid>/` | Codex worktrees, logs, outputs, snapshots, checkpoints, and `result.json`. |

Use the paths returned by the runner rather than guessing them.
Pruning removes completed artifacts but preserves active runs, conflicts, patches, checkpoints, unfinished runs, and failed attempts requested through `keepFailed`.

## Codex DIRECT, commits, and recovery

| Operation | Required steps |
|---|---|
| DIRECT | Supply actual `contextTokens` and `contextWindow`; the router must also judge the task small. |
| Complete DIRECT | Edit only the returned `worktreePath`, then resubmit the original input with `directRun` and `directSummary`. |
| Force normal ladder | Use `forceLadder: true`, which also disables split suggestions. |
| Run a large task | No split confirmation is required; if the forecast says usage may run out, answer the usage-risk question (`acceptUsageRisk: true` continues). |
| Commit | Explicitly enable `commit: true` to commit verified files without unrelated staged changes. |
| Resume a timeout | Reuse the original input and returned `resumeRun`; the skill retries automatically at most twice. |

DIRECT is never completion; obey returned protection rules and independently verify before applying.
If the caller cannot edit the draft under its sandbox, use the normal ladder without bypassing permissions.
Resume validates the original checkout, configuration, task, and acceptance criteria, then continues the draft in a fresh worktree.
Do not automatically resume cancellations, quota stops, or unresolved environment errors.
Files with pre-existing or concurrent edits skip the commit, and skipped or failed commits leave the verified change applied with `outcome.note`.
No run pushes changes.

## Advanced settings

Settings resolve as defaults, personal file, then project file; `usageGuard` merges field by field.
Personal files are `~/.claude/model-ladder.json` and `~/.codex/model-ladder.json`; project files use `.claude/` and `.codex/` respectively.

| Key | Default | Meaning |
|---|---|---|
| `router` | Claude: `sonnet/low`; Codex: `gpt-5.6-terra/low` | Route tasks and diagnose failures. |
| `verifier` | Claude: `haiku/low`; Codex: `gpt-6-luna/low` | Independently check results. |
| `tiers` | Haiku, Sonnet, Opus; Codex uses Luna, Terra, Sol | Ordered models and efforts, with `maxEffortJump` limiting effort increases. |
| `maxAttempts` | `4` | Maximum attempts. |
| `verify` | Discovered | Existing command or project verification skill. |
| `protected` | `[]` | Extra paths workers cannot modify. |
| `commit` | `false` | Commit verified changes when explicitly enabled. |
| `keepFailed` | `false` | Retain failed worktrees. |
| `timeoutMs` | `600000` | Codex idle timeout per role or verify command. |
| `usageGuard` | Enabled, `90%` | Usage protection, preferably stored in the personal file. |
| `worker_skills` / `verifier_skills` | Empty | Natural-language role instructions. |
| `direct_threshold` | `30` | Context percentage for small-task DIRECT, or `"off"`. |
| `autoRun` / `band` | `true` | Default routing and display controls. |

Claude model aliases follow available versions; configure Codex model IDs and efforts for your account.
Claude's plugin picker offers DIRECT values 20–80 and split values 10, 20, 30, 45, or 60 minutes, plus `off`.
Without explicit `verify`, Codex prefers a project verify skill, then discovers existing npm, pytest, Cargo, Go, Maven, or Make checks.

| Environment variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | Change the personal settings directory. |
| `MODEL_LADDER_USER_CONFIG` | Select a personal settings file directly. |
| `MODEL_LADDER_AUTORUN=0` | Disable default routing. |
| `MODEL_LADDER_BAND=0` | Hide the Codex panel independently of autorun. |
| `CODEX_BINARY` | Select a native Codex executable. |
| `MODEL_LADDER_NO_UPDATE_CHECK=1` | Disable version checks. |

Claude plugin role instructions provide defaults that project keys override, including an explicit empty string.
Use one rule per line: `model-ladder: use plugin:skill` applies only when the main repo folder is exactly `model-ladder`; lines without a `project: ` prefix apply globally, including ones with a colon such as `use ponytail:ponytail`.
The first colon separates the project name; matching bodies retain later colons, and empty or unresolved `${...}` values add no instructions.
Unavailable capabilities are reported before execution and in the final report, for example: `ponytail` is not available in this project.
Role instructions may name skills, plugins, slash commands, or MCP servers, but cannot expand permissions, permit verifier edits, or recurse into the ladder.

## Band and panel details

Basic fields and controls are shown in the [README](README.md#band-claude-code).

| Detail | Behavior |
|---|---|
| Context | Claude shows `ctx 287k/1M (28.7%)`, only the window if tokens are unknown, or nothing without a known window. |
| Codex context | No automatic source exists; never invent numbers to enable DIRECT. |
| Guard controls | Save only the changed field to personal settings; project overrides remain effective. |
| Threshold | Enter or 5 seconds without typing saves it without changing the guard switch. |
| Instructions | Only matching and global rules appear, without a label prefix; the Band previews one line and its arrow expands or collapses the text. |
| Claude handoff | `handoff now` writes a template, then submits `/model-ladder:handoff` when the session is idle. |
| Handoff fallback | If submission fails, a toast gives the command; the template remains available. |
| Codex controls | Enter `g`, `t 90`, `h`, or `q`, followed by Enter. |
| CLI controls | `watch.mjs` accepts `--guard on|off`, `--threshold 1-100`, and `--handoff`. |

Manual handoff does not cancel the run.
If Codex autorun or its panel is missing, check that the plugin is enabled, restart the session, and review/trust its hooks in `/hooks`.
Explicitly invoking the ladder skill also initializes the panel; no editor UI extension is installed.

## Usage protection details

| Condition | Behavior |
|---|---|
| Claude usage threshold | Checked before a run and after failed attempts. |
| Codex usage threshold | Checked at role boundaries and every 2 seconds during execution. |
| Usage stop in an active run | Stops the run and other registered runner process trees on the machine. |
| Unknown usage | Does not block execution. |
| Hard quota limit | Stops even when the guard is off, including recognized limit-only responses. |
| Auth, sandbox, or model-access error | Stops as an environment error rather than a quota handoff. |
| Windows denies tree termination | Report the failure, retain registration, and never claim the process stopped. |

Do not bypass the sandbox, clear a live lock, or replace process-tree termination with a single-PID kill.
Registered runner termination does not imply control over arbitrary Claude host sessions or hosted agents.
Claude usage comes from the Band or `scripts/usage-statusline.mjs`; only Pro/Max plans report it.

`USAGE_LIMIT` retains available draft work and writes `.model-ladder/HANDOFF.md`.
The main session adds the goal, decisions, completed work, next steps, and resume instructions above the unchanged generated verification appendix, which remains authoritative.
If the session cannot call a model, keep the template as the fallback.
A force-killed run may lack a checkpoint or `result.json`; inspect its draft and restart the original task after quota reset instead of inventing `resumeRun`.

Duration forecasts are stored in live/result/history JSON; the panel time column shows elapsed/expected (most-likely total).
They cover routing, implementation and self-checks, test commands, independent
verification and retry risk. Router ranges are uncalibrated judgments until
comparable successful histories supply empirical min/median/max error ratios.
Those ranges are observations, not confidence intervals or accuracy claims.
Original forecasts, boundary updates, phase models, efforts, tokens and clock timings,
actual elapsed time and signed/absolute error remain in history. Interrupted,
DIRECT, errored and aborted runs are censored; failed runs are retained but never
used as successful calibration evidence. Comparability requires the same runtime,
starting cell, router, verifier, verification command, attempt limit, router estimate and task mode;
only the last 90 days are used. Continuations use separate histories and retain
the earlier original forecast. Without comparable continuation data, their bounds
remain unknown.

Usage is assessed separately for each available subscription window, against both
100% headroom and the enabled guard threshold. Minutes and tokens never convert to
subscription percentages. Evidence needs fresh before/after samples, the same
source, account identity and reset, nondecreasing percentages and attributable
exclusive account activity. Boundary checks conservatively compare full-run
consumption with current headroom. They do not assume a linear consumption rate.
The current providers cannot prove absence of other account activity,
so their observations normally yield unknown with reasons. Missing timestamps,
stale samples, resets, incomplete and failed runs cannot establish sufficiency.
Estimates do not bypass or replace the existing live usage guard.

Claude records wall-clock boundaries through the Node forecast recorder around
each Workflow call; the workflow itself reads no clock and imports nothing. A
structured journal continues one agent at a time without repeating model calls.
These timings include host overhead and gaps inside each call; preflight-to-finish
elapsed time includes user/host waits. Open boundaries are censored on errors.
