# Changelog

All notable changes to model-ladder. Versions follow [semantic versioning](https://semver.org); Claude Code only offers an update when `version` in `.claude-plugin/plugin.json` changes.

[繁體中文](CHANGELOG.zh-TW.md)

## [Unreleased]

## [1.0.1] - 2026-10-30

- Codex supports DIRECT when actual caller context data is available. The session edits an isolated draft and returns it for independent verification before application.
- Codex supports opt-in commits of verified files, preserving unrelated staged changes and skipping commits that would include pre-existing or concurrent edits.
- Codex SessionStart respects personal and project autorun/panel settings. Test-writing prompts now include the same behavioral rules as Claude's test-writer.
- Quota handoffs use per-run live state, and native Codex quota errors also stop other registered runners. Updated both runtime skills and bilingual documentation, including the existing Codex split_minutes support and platform limits.
- If Windows denies process-tree termination, report the error and keep the active registration. Do not mark the surviving run stopped or write a false stopped handoff.

- **Usage limit stops every run at once.** When usage reaches the `usageGuard` threshold, or Claude's hard subscription limit stops an agent, model-ladder no longer waits for the current agent to finish. It force-stops every other model-ladder run on this machine, including its Codex child processes, and writes each stopped run's `.model-ladder/HANDOFF.md` with a Stopped section. `node scripts/usage-guard.mjs --enforce` does the same from the command line.
- **Codex checks usage mid-agent.** The Codex runner checks usage every 2 seconds and aborts the running Codex child or verify command as soon as the threshold is reached.
- **Limit text counts as a usage stop.** An agent that returns only limit text (for example "You've hit your 5-hour limit") instead of a report now stops the ladder as `USAGE_LIMIT`.

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
