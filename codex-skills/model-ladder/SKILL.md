---
name: model-ladder
description: Run a task through the model-ladder plugin in Codex. Choose a cheap model and effort, verify in an isolated worktree, and escalate only after failure. Use when asked to use model-ladder or the model ladder.
---

# model-ladder

Run the user's task through the Codex runner. Do not implement the task yourself.

1. Locate this SKILL.md on disk using the skill path supplied by Codex. Resolve ../../scripts/codex-run.mjs relative to its containing directory. Do not use CLAUDE_PLUGIN_ROOT or a guessed installation path.
2. Run that script with Node 20+ from the target Git repository root. Pass a JSON object on stdin with task and, only if already provided by the user, acceptance as an array of strings. Use the platform's literal stdin or temporary-file support so task text cannot become shell code. The script also accepts a task as one argument.
3. Follow the JSON result. DIRTY means show files and ask whether to run on top of those uncommitted changes, then rerun with allowDirty true only after user authorization. NEEDS_INPUT means ask its message and rerun with the clarified task or the user's acceptance criteria. Never invent approval of criteria. STALE_RUN means inspect .model-ladder/run.json and the live process first. Do not clear a live run's marker. STOPPED means fix the stated environment or ask the necessary clarification before rerunning. ERROR and FAILED mean report the failure. CONFLICT means report the retained patch and worktree paths for review. VERIFIED means report the summary, verified checks, attempt cells and applied files. A report-only task returns its report in summary.

The same plugin package also supports Claude Code through /model-ladder:run. Codex uses this skill and its own .codex/model-ladder.json settings. Defaults use gpt-6-luna, gpt-6.1-sol and gpt-6-astra. If an account does not expose them, configure available model IDs and supported efforts. Unavailable models stop the run. Optional CODEX_BINARY names the native Codex executable. Keep the installed sandbox and approval controls. Never add bypass flags.

Successful changes are applied without committing or pushing. Existing uncommitted changes are snapshotted without altering the user's Git index. Verification requires an existing configured/discovered test command or acceptance criteria explicitly supplied by the user. All runs record result.json and history under .model-ladder; recommend ignoring that directory.
