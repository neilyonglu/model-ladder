# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

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

[0.1.6]: https://github.com/neilyonglu/model-ladder/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/neilyonglu/model-ladder/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/neilyonglu/model-ladder/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neilyonglu/model-ladder/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neilyonglu/model-ladder/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/neilyonglu/model-ladder/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/neilyonglu/model-ladder/releases/tag/v0.1.0
