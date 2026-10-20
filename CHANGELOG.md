# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

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

[0.1.5]: https://github.com/neilyonglu/model-ladder/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/neilyonglu/model-ladder/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neilyonglu/model-ladder/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neilyonglu/model-ladder/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/neilyonglu/model-ladder/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/neilyonglu/model-ladder/releases/tag/v0.1.0
