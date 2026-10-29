# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

[繁體中文](CHANGELOG.zh-TW.md)

## [Unreleased]

## [1.0.0] - 2026-10-29

First public release. Earlier development history was squashed into this version.

- **Model ladder for Claude Code and Codex.** A router picks the cheapest model and effort likely to succeed. Each attempt runs in its own Git worktree, an independent verifier checks it, and a failure escalates to a stronger model or higher effort. Verified changes are applied to your checkout without committing.
- **Direct path.** When the task is small and the session already holds `direct_threshold` percent of its context window (measured by the band), the session does the task itself and still has it verified.
- **Split suggestions.** The router estimates how many minutes a task takes. Over `split_minutes`, it proposes smaller tasks that each verify on their own; you choose to run them in order, run the whole task, or stop.
- **Concurrent runs.** Runs whose files do not overlap run at the same time, in Claude Code, in Codex, or across both. Results are applied one at a time.
- **Usage guard and handoff.** The guard stops a run at your usage threshold; you alone turn it on or off. On `USAGE_LIMIT`, including Claude's hard subscription limit, finish writes `.model-ladder/HANDOFF.md` and the main session rewrites it from the conversation. `/model-ladder:handoff` writes one on request.
- **Role instructions.** `worker_skills` and `verifier_skills` let workers and verifiers use any skill, plugin, slash command or MCP tool. The session warns when a named capability is unavailable in the project.
- **Settings in layers.** Defaults, then your user file (`~/.claude/model-ladder.json` or `~/.codex/model-ladder.json`), then the project file. Claude Code also reads the plugin settings screen (Configure model-ladder).
- **Band and HUD.** The Claude Code band shows active roles for every run, usage and context (`ctx 287k/1M (28.7%)`). The Codex CLI HUD shows a one-line status under Codex in the same terminal.
- **Clean repository.** Run artifacts live in the system temp directory, and each run adds `.model-ladder/` and `.claude/worktrees/` to `.git/info/exclude`.
- **Targeted verification.** The router picks a verify command that runs only the tests related to the change; CI runs the full suite.
- **Node.js check.** Hooks print an install message when Node.js 20 or later is missing.
