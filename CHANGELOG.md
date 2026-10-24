# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

## [Unreleased]

## [1.7.0] - 2026-10-24

### Added

- Band status dot before the title: 🟢 a worker, test-writer or router is running, 🔵 the verifier is running, 🔴 a worker is retrying after a failed check in the same run. No dot when nothing runs.
- Band `[handoff now]` button writes `.model-ladder/HANDOFF.md`; the usage header shows a reset countdown such as `2h/5h 15%`.
- Plugin options `worker_skills` and `verifier_skills` load companion skills into those roles; the band shows them as `with: …`.

### Changed

- Every top-level task goes through the ladder, which decides direct vs agents; outside git, the session says so and works directly.
- Band threshold saves 5 seconds after typing stops (Enter saves at once); the set button is gone.
- Outside the terminal, the band's task column fills the row and truncates at the edge.
- README reorganized by features and scenarios.

### Fixed

- The verifier no longer counts the user's uncommitted changes as the worker's: SETUP stages the setup patch, so the diff shows only the worker's edits.

### Documentation

- Bring the design document up to v1.6.0: both runtime entry points, default-on session guidance and usage guards, Claude band, Codex idle timeout/resume, and live monitor state and controls.
- Clarify that Codex checks task completion independently after Node runs project tests; distinguish verifier sandbox permissions for edits and reports.
- Refresh development commands and separate historical validation counts from the current offline suite.

## [1.6.0] - 2026-10-23

### Added

- Codex progress snapshots show quota usage, each role's model/effort, elapsed time and task whenever a role starts or ends. Verification commands are included, and completed roles show success or failure with frozen elapsed time.
- Atomic `.model-ladder/live.json` updates at role start/end and final cleanup, including handled cancellation and idle timeout.
- `scripts/watch.mjs` refreshes the table every second, truncates tasks to terminal width with Chinese characters counted as two cells, and hides completed rows after ten seconds. `--guard on|off` and `--threshold 1–100` update the project config without replacing other fields; invalid arguments leave it unchanged.
- Offline unit coverage and a fake-Codex runner/monitor demonstration, including an optional terminal redraw preview.

### Changed

- Codex usage reading can return separate unexpired 5-hour and weekly windows while preserving the guard's existing highest-window check. Unknown or unidentifiable display windows show `?`.
- A running Codex ladder reloads usage guard settings at the next role or verification-command boundary.
- README documents progress output, monitor commands, state format and limitations.

## [1.5.0] - 2026-10-23

### Added

- The ladder by default, with no `CLAUDE.md` or `AGENTS.md` edit: a session-start hook in Claude Code and Codex says that top-level coding tasks in a git repository go through model-ladder unless the user says to skip it. Turn it off with the plugin option **Use the ladder by default** or `MODEL_LADDER_AUTORUN=0`. Codex asks once to trust the hook (`/hooks`).

### Changed

- Everything is on after install. The usage guard is on by default at 90% in Claude Code and Codex; set `{"usageGuard": {"enabled": false}}` to turn it off. A partial `usageGuard` keeps the other field's default in Codex too.
- The band records the subscription usage into `.model-ladder/usage.json`, and preflight and the verifier read it first, so the Claude Code usage guard needs no statusline. The statusline script stays as a fallback.
- The band can be hidden with the plugin option **Show the band** (`/plugin configure model-ladder`); the usage guard keeps working.
- README: what is on after install, a band screenshot, and how to turn each feature off.

### Fixed

- A Windows-only test compared temp paths that Windows spells two ways (short and long names).

## [1.4.0] - 2026-10-23

### Added

- Claude Code band above the prompt: subscription usage, each running ladder agent's model/effort, time and task (a finished row shows `✓` for 10 seconds), and usage guard and threshold controls that write `.claude/model-ladder.json`.

### Changed

- The route, verify and diagnose agent labels now carry their model and effort, like the worker's.
- The repository ignores `.model-ladder/` and `.claude/worktrees/`.
- Ladder agents (router, worker, test-writer, verifier) no longer stop at a fixed number of turns; an agent runs as long as it keeps working. The band shows how long each one has run and notifies once when one passes 10 minutes.

## [1.3.0] - 2026-10-23

### Added

- Claude Code opt-in `usageGuard` (`enabled`, `threshold`): a statusline script (`scripts/usage-statusline.mjs`) saves the Pro/Max 5-hour and weekly usage; preflight returns `USAGE_LIMIT` at the threshold before writing a run marker, the verifier reports usage after each attempt, and a failed attempt at the threshold stops the run with `USAGE_LIMIT`, keeps the last worktree and writes `.model-ladder/HANDOFF.md`.

### Fixed

- Claude Code finish no longer corrupts the result patch when it ends in a blank context line; such verified results were reported as "does not apply cleanly".

## [1.2.0] - 2026-10-23

### Added

- Codex opt-in `usageGuard` (`enabled`, `threshold`): reads Codex session rate limits before each role and verify command, stops with `USAGE_LIMIT` at the threshold, keeps the checkpoint and writes `HANDOFF.md` (`handoffPath`).

### Changed

- Codex `timeoutMs` is now an idle limit: a role or verify command is stopped only after `timeoutMs` with no output, instead of after `timeoutMs` in total.

## [1.1.0] - 2026-10-23

### Changed

- Codex defaults now mirror the Claude defaults role for role: `gpt-6-luna` for Haiku, `gpt-5.6-terra` for Sonnet and `gpt-6.1-sol` for Opus. The router runs on `gpt-5.6-terra/low` and the semantic verifier on `gpt-6-luna/low`. `gpt-6-astra` is no longer a default tier.

## [1.0.1] - 2026-10-23

### Fixed

- Check and apply changes to baseline-tracked files under artifact directories instead of silently ignoring them. Newly generated artifacts remain excluded.
- Add UTF-8 JSON file input for Codex, including Windows PowerShell BOM support, and distinguish waiting states with a nonzero exit code.
- Check task completion independently after passing project tests. Allow editing-task verifiers to create build artifacts while rejecting source tampering.
- Preserve partial logs and unverified worktrees on interrupted Codex attempts. Resume from a checked checkpoint in a fresh worktree, with bounded automatic timeout continuation in the skill.
- Report each role as it starts and prevent Windows child cancellation from waiting indefinitely on `taskkill`.

## [1.0.0] - 2026-10-21

### Added

- Codex support in the same model-ladder plugin package, with a native skill, marketplace metadata, configurable model grid and standalone Node runner.
- Independent worktree attempts, command/acceptance verification, legal escalation, protected-file checks, dirty snapshot preservation, bounded logs and conflict recovery for Codex.
- Fake-CLI integration checks using real Git repositories and a generated shared rule module with drift detection.
- Documented model-selection rationale and local validation results: 91 offline tests passed, native Codex installation and a controlled read-only flow passed. Native write validation remains blocked by the local Windows sandbox ACL setup.

### Fixed

- Acquire the shared Claude Code/Codex run marker atomically before snapshotting.
- Preserve exact patch bytes, protect selected verification inputs including npm workspace scripts, permit verification build artifacts, and stop on unsupported-model errors.

## [0.1.7] - 2026-10-20

### Changed

- The ladder-or-direct context threshold is 300k tokens, up from 150k.

### Fixed

- The acceptance prompt could still arrive as one flat paragraph, because the skill left the layout to the model. The workflow now returns `acceptanceMessage` (the start cell and a numbered criteria list) and a short `acceptanceQuestion`; the skill prints and asks them verbatim.

## [0.1.6] - 2026-10-20

### Changed

- A read-only task runs without a worktree. The router returns `readOnly`; the worker then works in the user's own checkout with no reset or setup patch, must edit nothing (an attempt that changes a file fails), and its report is the result. Finish never applies a read-only winner, so the user's uncommitted changes are not staged. This also avoids worktree failures that a read-only task has no reason to risk.

### Fixed

- A read-only task (a review or report, no file edits) no longer fails as "worker changed nothing". Without a verify command, an attempt that changed no files goes to the verifier, which judges the worker's report against the acceptance criteria. Finish prints that report, since nothing else carries it back. With a verify command, an empty diff still fails.
- `directReason` said the context was "above 150000" even when it was not. It now says above or not above the threshold.
- The acceptance prompt crammed the router's reason and every criterion into one paragraph. The skill now prints them as a numbered list first and asks a short question.

## [0.1.5] - 2026-10-20

### Changed

- The ladder-or-direct check moved out of the skill text: the skill passes its estimated context size as `contextTokens`, the router judges after reading the code whether the task is small, and the workflow returns `DIRECT` when it is and the context is above 150k tokens (a fixed threshold in code). Finish records it, and the skill then does the task itself. `--ladder` still forces the ladder.

## [0.1.4] - 2026-10-20

### Added

- `/model-ladder:run` skips the ladder for a small task (one or two files, design given) in a large session (above about 150k tokens of context), and does the task directly, because orchestration cost grows with the caller's context. `--ladder` forces the ladder. The thresholds are provisional; see DESIGN.md.

## [0.1.3] - 2026-10-20

### Fixed

- Attempts ran on the remote default branch instead of the user's current commit, because Claude Code creates worktrees from `origin/HEAD`. On a feature branch the worker saw the wrong code, and a verified result would have carried back the difference between the two branches. Each attempt now resets its worktree to the commit recorded by preflight before applying uncommitted changes, and the verifier fails an attempt on any other base.

## [0.1.2] - 2026-10-20

### Fixed

- `--allow-dirty` failed with "staged content different from both the file and the HEAD: .model-ladder/index" in a repo that does not ignore `.model-ladder/`.

## [0.1.1] - 2026-10-20

### Added

- The report says when a newer model-ladder is published, with the update command. Checked at most once a day; set `MODEL_LADDER_NO_UPDATE_CHECK=1` to turn it off.
- Calling the internal `/model-ladder:ladder` workflow directly now stops with a pointer to `/model-ladder:run`.
- CI fails when plugin files change without a version bump.

## [0.1.0] - 2026-10-20

First release: cheap-first model × effort ladder for Claude Code, with a router, isolated worktree attempts, a verifier, protected tests, and history. Includes path matching that works with Windows 8.3 short names.

[1.0.0]: https://github.com/neilyonglu/model-ladder/compare/v0.1.7...v1.0.0
[0.1.6]: https://github.com/neilyonglu/model-ladder/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/neilyonglu/model-ladder/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/neilyonglu/model-ladder/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neilyonglu/model-ladder/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neilyonglu/model-ladder/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/neilyonglu/model-ladder/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/neilyonglu/model-ladder/releases/tag/v0.1.0
