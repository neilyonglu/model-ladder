<div align="center">

# 🪜 model-ladder

**Route each task to a suitable model, complete it, verify the result, and deliver only after verification.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.md#install)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [繁體中文](README.zh-TW.md) · [How to use](#how-to-use) · [Configure](#configure) · [Band](#band-claude-code) · [Usage guard](#usage-guard) · [Design](DESIGN.md)

</div>

---

## What it does

model-ladder is a [Claude Code](https://code.claude.com) and Codex plugin. The Router selects a suitable model for each task, the Worker executes it, and the Verifier checks the result. Verified changes are delivered.

## Features

- **Isolated Git worktrees**: each attempt runs in its own worktree.
- **Escalation when appropriate**: verification failure may lead to a stronger model or higher effort.
- **DIRECT for small tasks**: when actual session context reaches the configured threshold, the session handles small tasks and still submits them for independent verification.
- **Forecasts**: the panel time column shows elapsed/expected (for example `5s/12m`), and when the startup forecast says a subscription window is insufficient or at risk, the ladder asks once before any worker starts; long tasks run without split confirmation.
- **Concurrent runs**: runs with separate file scopes can proceed together, with overlap checks and serialized application of results.
- **Automatic routing and layered settings**: session hooks enable the ladder by default, with personal settings and project overrides.
- **Protected tests**: workers cannot modify tests unless the task explicitly asks for test changes.
- **Usage protection**: a detected usage stop ends the current run and force-stops other registered runs on the machine, with Codex checking every 2 seconds during execution.
- **Handoff document**: usage stops or `/model-ladder:handoff` create `.model-ladder/HANDOFF.md`, which the main session rewrites from the conversation while preserving the program-generated verification appendix.
- **The band / panel / HUD**: view active roles, usage, and guard controls in the Claude band or Codex terminal displays, with Claude also showing context tokens and percentage.
- **Custom role instructions**: `worker_skills` and `verifier_skills` select available skills and tools within each role's permissions, while the Claude Router has only Read, Grep, and Glob.
- **Codex timeout recovery**: `TIMEOUT` results with a checkpoint support `resumeRun` to continue the draft and verify it before application.
- **Optional Codex commits**: `commit: true` commits verified files while preserving unrelated staged changes and skipping files with pre-existing or concurrent edits.

## Install

Requires Git and Node.js 20 or later (the plugin does not install Node.js). Use it in a Git repository with at least one commit. In Codex, trust the plugin hooks in `/hooks` first.

Install and sign in to Claude Code first. For automation, make sure the Workflow tool is available. On Pro, enable it in `/config` before you install the plugin.

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
claude plugin marketplace add usio0108/model-ladder
claude plugin install model-ladder@model-ladder

# Codex CLI 0.160.1+ (restart Codex afterwards; needs an authenticated native `codex`)
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

Restart Claude Code after installing; top-level tasks then go through `/model-ladder:run` automatically. If the first run asks whether to allow Workflow, choose "don't ask again". model-ladder keeps `.model-ladder/` and `.claude/worktrees/` out of git itself (in `.git/info/exclude`), so you do not edit `.gitignore`. Update with `claude plugin update model-ladder@model-ladder` (automatic when the marketplace has auto-update on); reports announce new versions ([CHANGELOG.md](CHANGELOG.md)).

## How to use

1. **Everyday use**: describe your task in a Git repository and the ladder runs automatically by default.
2. **Start manually**: use `/model-ladder:run <task>` in Claude Code, or ask Codex to use the `model-ladder` skill.
3. **Describe the task**: state the goal and expected result, and explicitly request test changes or a review without edits when needed.
4. **Skip or force the ladder**: say "no ladder" to skip it, or add `--ladder` to the Claude command to force it.
5. **Answer prompts**: confirm work on uncommitted changes, clarify unclear tasks, and choose whether to split a large task, run it whole, or stop.
6. **Read the result**: completion requires verification, and the report lists changed files, checks, and remaining limits, with no commit or push by default.
7. **Hand off and resume**: request a handoff when needed, or wait for quota reset after a usage stop and follow `.model-ladder/HANDOFF.md` to resume.
8. **Set up project verification**: model-ladder bundles the pstack-derived [`create-verification-skill`](skills/create-verification-skill/SKILL.md) and [`maintain-verification-skill`](skills/maintain-verification-skill/SKILL.md) for Claude Code, with [Codex versions](codex-skills/) in the Codex plugin. In Claude Code, run `/model-ladder:create-verification-skill` or `/model-ladder:maintain-verification-skill`. In Codex, ask it to use the `create-verification-skill` or `maintain-verification-skill` skill. These skills generate or maintain a verification driver tailored to the target project. This repository already has its own driver at [`.agents/skills/verify/SKILL.md`](.agents/skills/verify/SKILL.md); it verifies model-ladder and is not a generic driver for other projects. See the [third-party notice](NOTICE.md) for the source and license.

See [advanced usage](USAGE.md) for report examples, runner commands, concurrent runs, and run files, and [Band](#band-claude-code) for panel controls.

## Configure

Defaults work without a settings file.

Claude Code: open `/plugin configure model-ladder`; Codex: edit `~/.codex/model-ladder.json`.
For Claude settings outside the plugin screen, use `~/.claude/model-ladder.json`.

| Setting | Default | Purpose |
|---|---|---|
| `autoRun` | `true` | Use the ladder by default. |
| `band` | `true` | Show the band or panel. |
| `worker_skills` (**Worker skill instructions**) | Empty | Skills or tools for workers and test-writers. |
| `verifier_skills` (**Verifier skill instructions**) | Empty | Skills or tools for verification. |
| `direct_threshold` | `30` | Context percentage for small tasks to use DIRECT; `off` disables it. |
| `usageGuard` | On, `90%` | Stop at the configured usage threshold. |

Project settings in `.claude/model-ladder.json` or `.codex/model-ladder.json` override personal settings; keep usage protection in your personal file unless the project needs an override.

Use one rule per line: `project: instructions` matches the main repo folder name exactly, while lines without a `project: ` prefix apply everywhere.

```json
{
  "worker_skills": "model-ladder: use <skills> to simplify code",
  "verifier_skills": "model-ladder: use <skills> to review without edits"
}
```

See [advanced settings](USAGE.md#advanced-settings) for models, retries, verification, protected files, and environment variables, or [Codex execution](USAGE.md#codex-direct-commits-and-recovery) for DIRECT, commits, and timeout recovery.

## Band (Claude Code)

The band appears above the Claude Code prompt and requires Claude Code 2.1.290+.

```text
▴ 🟢 model-ladder ── 2h/5h 15% · 3d/7d 44% · ctx 287k/1M (28.7%)
▸ worker use ponytail when coding
model/effort        time     task
haiku-5.5/low       5s       Summarize the README install steps
[usage guard: on]  threshold [90] %  [handoff now]
```

| Display or control | Meaning |
|---|---|
| Usage | Each window shows time to reset, window length, and usage percentage. |
| Context | `ctx 287k/1M (28.7%)` shows tokens used, window size, and percentage; unknown tokens show only the window. |
| Status | 🟢 worker or router, 🔵 verifier, 🔴 retrying worker, and `✓` for a finished row. |
| Task rows | Show the model, effort, elapsed time, and task. |
| `▴` / `▾` | Collapse or expand the band. |
| Instruction arrow | Show only applicable instructions without the `skill instructions:` prefix; expand the single-line preview with `▸` and collapse with `▾`. |
| `usage guard` | Toggle usage protection. |
| `threshold` | Set a threshold from 1 to 100%, saved on Enter or after 5 seconds without typing. |
| `handoff now` | Write the handoff template and submit `/model-ladder:handoff` for the main session to rewrite it without cancelling the run. |

Guard controls save to your personal settings, and project overrides still take priority.

The separate Codex terminal panel does not show context usage; enter `g` to toggle the guard, `t 90` to set the threshold, `h` to write a handoff template, or `q` to close the panel, followed by Enter.

See [band and panel details](USAGE.md#band-and-panel-details) for handoff fallbacks, settings behavior, and troubleshooting.

## Usage guard

- Enabled by default, with a 90% threshold for the 5-hour or weekly limit.
- Use the Band controls or Codex panel commands `g` and `t 90` to change protection settings.
- A usage stop returns `USAGE_LIMIT` and force-stops other registered model-ladder runs on this machine.
- Check `.model-ladder/HANDOFF.md` for retained work and resume instructions after quota reset.
- Hard limits still stop runs when the guard is off, while unknown usage does not block execution.

See [usage protection details](USAGE.md#usage-protection-details) for check timing, handoff behavior, and platform limits.

---

Design and lessons: [DESIGN.md](DESIGN.md). [MIT License](LICENSE), (c) 2026 usio0108. Found a problem? [Open an issue](https://github.com/usio0108/model-ladder/issues).
