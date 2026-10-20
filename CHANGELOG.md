# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

## [0.1.1] - 2026-10-20

### Added

- The report says when a newer model-ladder is published, with the update command. Checked at most once a day; set `MODEL_LADDER_NO_UPDATE_CHECK=1` to turn it off.
- Calling the internal `/model-ladder:ladder` workflow directly now stops with a pointer to `/model-ladder:run`.
- CI fails when plugin files change without a version bump.

## [0.1.0] - 2026-10-20

First release: cheap-first model × effort ladder for Claude Code, with a router, isolated worktree attempts, a verifier, protected tests, and history. Includes path matching that works with Windows 8.3 short names.

[0.1.1]: https://github.com/neilyonglu/model-ladder/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/neilyonglu/model-ladder/releases/tag/v0.1.0
