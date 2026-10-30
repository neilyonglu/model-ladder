# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

Versions follow semantic versioning; Claude Code updates require a new `.claude-plugin/plugin.json` version.

## [Unreleased]

## [1.1.0] - 2026-10-30

- Duration forecasts: structured ranges, phase timings and per-window usage headroom are recorded in live, result and history JSON and calibrated from comparable successful runs; the split prompt is removed.
- The panel time column shows elapsed/expected (for example `5s/12m`) in the Claude Code band and the Codex panel, falling back to elapsed time when no forecast exists.
- When the startup forecast says a usage window is insufficient or at risk, Claude Code and Codex ask once before any worker starts (`acceptUsageRisk: true` continues); the usage guard still applies.
- The Claude Code band shows a `no model` row while the main session holds a run between agents (preflight, questions, finish), instead of `idle`.
- The band writes `.model-ladder` state at the repository root, not the shell's current subfolder.
- The Codex usage guard now sees live usage during role processes, and Codex usage-limit errors write `HANDOFF.md` even when stderr has sandbox warnings.
- Lines like `use ponytail:ponytail` stay global; only a `project: ` prefix scopes a role instruction.

## [1.0.3] - 2026-10-30

- Scope role instructions with `project: instructions`, while unprefixed lines remain global.
- Show only applicable instruction text in the Band, with a collapsible single-line preview and no `skill instructions:` label.
- Apply the same project selection in Claude Code, Codex, and linked worktrees.

## [1.0.2] - 2026-10-30

- Shortened plugin settings descriptions, including context-window information in the Band option.
- Added the installed version to the first configuration label.
- Simplified both language editions of the README, advanced usage, design notes, and release history.
- Updated Band examples and moved detailed operation and configuration references to the advanced guides.
- Removed unreliable performance comparisons and outdated test-result claims, preserving third-party license text.

## [1.0.1] - 2026-10-30

- Codex DIRECT uses measured caller context and an isolated draft that must pass independent verification before application.
- Optional Codex commits preserve unrelated staged changes and skip files with pre-existing or concurrent edits.
- Codex SessionStart respects personal/project autorun and panel settings, with test-writer rules aligned across runtimes.
- Quota handoffs use per-run live state, and detected usage stops terminate other registered runner process trees and write `HANDOFF.md`.
- Codex polls usage every 2 seconds during agents and verify commands.
- Recognized limit-only responses stop as `USAGE_LIMIT`.
- Windows process-tree termination failures retain registration and report the error without a false stopped handoff.
- Updated both runtime skills and bilingual documentation for DIRECT, commits, splitting, and platform limits.

## [1.0.0] - 2026-10-29

First public release, including prior development history.

- Route Claude Code and Codex tasks to suitable models, isolate attempts, verify independently, and escalate failed attempts.
- Small Claude tasks can use DIRECT at `direct_threshold`, with independent verification still required.
- Above `split_minutes`, choose sequential parts, the whole task, or stop.
- Non-overlapping runs execute concurrently and apply results one at a time.
- Usage stops preserve work and write `.model-ladder/HANDOFF.md`; `/model-ladder:handoff` creates one on request.
- `worker_skills` and `verifier_skills` select available role capabilities and report missing ones.
- Layer defaults, personal settings (`~/.claude/model-ladder.json` or `~/.codex/model-ladder.json`), and project overrides.
- Claude Band shows roles, usage, and context; Codex HUD shows status in the same terminal.
- Codex artifacts use system temp, while Git excludes `.model-ladder/` and `.claude/worktrees/` automatically.
- Local verification targets relevant tests, with the full suite left to CI.
- Hooks explain installation requirements when Node.js 20+ is missing.
