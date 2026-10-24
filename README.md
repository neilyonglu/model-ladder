<div align="center">

# 🪜 model-ladder

**Start every task on the cheapest model that can do it. Climb only when your tests say so.**

[![test](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml/badge.svg)](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![release](https://img.shields.io/github/v/release/neilyonglu/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![vs opus/xhigh](https://img.shields.io/badge/vs%20opus%2Fxhigh-42%25%20cheaper-brightgreen)](#benchmark)

[Install](#install) · [How to use](#how-to-use) · [Configure](#configure) · [Band](#band-claude-code) · [Usage guard](#usage-guard) · [Benchmark](#benchmark) · [Turn off](#turn-features-off) · [Design](DESIGN.md)

</div>

---

## What it does

model-ladder is a plugin for [Claude Code](https://code.claude.com) and Codex. It starts your task on the cheapest model at the lowest effort, in an isolated git worktree, and checks the result with your own tests. If an attempt fails, a router reads what went wrong and moves up one step (more effort, or the next model). By default every top-level task goes through it, and the router may hand a small task back to your session to do directly.

## Features

- **Ladder escalation**: each attempt runs in its own git worktree; only a verified change reaches your working tree (uncommitted).
- **Router diagnosis**: after a failure the router picks the next step, or stops and explains when the problem is the environment or an unclear task.
- **Read-only tasks**: questions and reviews run on the ladder too, with no files changed.
- **Usage guard**: stops before you burn through your 5-hour or weekly limit.
- **The band** (Claude Code): live agents, usage with reset countdown like `2h/5h 15%`, and a `[handoff now]` button.
- **Companion skills per role**: `worker_skills` and `verifier_skills` load skills such as `ponytail:ponytail`.
- **Handoff file**: `.model-ladder/HANDOFF.md` lets you or another session pick up a run.
- **Codex support**: same rules with Codex models.

## Install

Needs git, Node.js 20+, and a repo with at least one commit.

```text
# Claude Code (needs the Workflow tool; on Pro enable it in /config)
/plugin marketplace add neilyonglu/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
claude plugin marketplace add neilyonglu/model-ladder
claude plugin install model-ladder@model-ladder

# Codex CLI 0.160.1+ (restart Codex afterwards; needs an authenticated native `codex`)
codex plugin marketplace add neilyonglu/model-ladder
codex plugin add model-ladder@model-ladder
```

On after install. Add `.model-ladder/` and `.claude/worktrees/` to `.gitignore`. Skip the per-run approval with `{"permissions":{"allow":["Workflow"]}}` in `.claude/settings.json`. Update with `claude plugin update model-ladder@model-ladder`; reports announce new versions ([CHANGELOG.md](CHANGELOG.md)).

## How to use

Claude Code: `/model-ladder:run <task>`. Codex: ask for the `model-ladder` skill. Outside a git repo the assistant says it needs one and does the task directly; say "no ladder" to skip.

1. **Fix a bug**: `/model-ladder:run Fix the off-by-one in pagination`. haiku/low tries first and your tests pass, so the fix is applied. If it fails, the router moves to sonnet/medium and tries again.
2. **Build a feature with tests**: `/model-ladder:run Add a --json flag to the export command, with tests`. Because the task is about tests, workers may edit them. Otherwise tests are protected: a worker cannot change them to pass.
3. **Ask or review (nothing changes)**: `/model-ladder:run Review src/auth.ts and list risks`. The answer comes back in the report; no files are changed.
4. **Stopped by the usage guard**: `/model-ladder:run Migrate the settings module to the new config format`. After a failed attempt your 5-hour usage is at 90%, so the run returns `USAGE_LIMIT`, keeps the last worktree and writes `.model-ladder/HANDOFF.md`. Rerun after the reset.
5. **Small task returned as DIRECT**: `/model-ladder:run Rename the variable tmp to buffer in utils.py`. In a very long Claude session (over about 300k tokens) a small task is done directly by your session instead of by agents. Add `--ladder` to force the ladder.

A finished run looks like this:

```text
model-ladder ── VERIFIED
Task      Fix the typo in the welcome message
Verify    uv run pytest tests/test_messages.py
Tests     protected (router: Bug fix; the existing test defines expected behavior.)
Start     haiku/low (router: One-character typo in shop/messages.py.)

#  Model / Effort   Result   Why next
1  haiku / low      PASS     —

Changed   shop/messages.py
Applied   to the working tree (not committed)
```

Verify is your test command and each table row is one attempt. It asks first when you have uncommitted changes, the task is vague, no tests exist, or `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set. Every run is logged to `.model-ladder/history.jsonl`.

Codex runner directly: `node scripts/codex-run.mjs "<task>"`; only `VERIFIED` exits 0. Watch it live with `node scripts/watch.mjs [--cwd <repo>]`. Codex uses router `gpt-5.6-terra/low`, verifier `gpt-6-luna/low` and tiers Luna, Terra, Sol (replace with models your account has); it has no `DIRECT` shortcut or `commit` option.

## Configure

Optional per project: `.claude/model-ladder.json` (Claude Code) or `.codex/model-ladder.json` (Codex). Each key you set replaces its default.

| Key | Default (Claude) | Meaning |
|---|---|---|
| `router` | `{"model":"sonnet","effort":"low"}` | Picks the start, diagnoses failures |
| `verifier` | `{"model":"haiku","effort":"low"}` | Runs the verify command (router's model judges when there is none) |
| `tiers` | haiku low-high, sonnet low-high, opus low-xhigh | The grid, weakest first; `maxEffortJump` caps effort steps per move (2, 2, 1) |
| `maxAttempts` | `4` | Attempts before giving up |
| `verify` | found by the router | Command that proves the task is done |
| `protected` | `[]` | Extra globs no worker may modify |
| `commit` | `false` | Commit the verified change (Claude only) |
| `keepFailed` | `false` | Keep failed attempts' worktrees |
| `usageGuard` | `{"enabled":true,"threshold":90}` | Stop at `threshold`% (1-100) of the 5-hour or weekly limit; fields can be set alone |
| `timeoutMs` | `600000` | Codex only: idle limit per role or verify command |

Models are aliases (`haiku`, `sonnet`, `opus`), so new versions are picked up automatically. Codex `tiers` use `efforts` and `maxEffortJump` the same way. Without `verify`, Codex uses `.agents/skills/verify/SKILL.md` or `.claude/skills/verify/SKILL.md` if present, else an existing npm, pytest, Cargo, Go, Maven or Make test command.

Plugin options (`/plugin configure model-ladder`): `autoRun` (use the ladder by default) and `band` (show the band), both on. `worker_skills` and `verifier_skills` are comma-separated skills those roles load before working, e.g. `ponytail:ponytail`; the band shows them as `with: …`.

## Band (Claude Code)

A band above the prompt shows each running ladder agent and the usage guard. A dot before the title shows what is running: 🟢 a worker or router, 🔵 the verifier, 🔴 a worker retrying after a failed check. Needs Claude Code 2.1.290+.

<p align="center"><img src="assets/band.png" width="505" alt="The model-ladder band, idle: 5-hour usage 10%, weekly 44%, usage guard on at 90%."></p>

```text
▴ model-ladder ── 2h/5h 15% · 3d/7d 44%
model/effort        time     task
haiku-5.5/low       ✓ 5s     Summarize the README install steps
[usage guard: on]  threshold [90] %
```

The header is `<time to reset>/<window> <percent>`. A `handoff now` button writes `.model-ladder/HANDOFF.md` for the current or last run. `usage guard` and `threshold` write `.claude/model-ladder.json` and apply from the next run. The threshold saves 5 seconds after you stop typing, or at once on Enter. Codex has the same table via `scripts/watch.mjs` (`--guard on|off`, `--threshold 1-100`).

## Usage guard

On by default. A run does not start, and stops after a failed attempt, once the 5-hour or weekly limit reaches `threshold` (default 90%). It returns `USAGE_LIMIT`, keeps the last worktree and writes `.model-ladder/HANDOFF.md`. A running attempt is never interrupted; unknown usage never blocks. Claude usage comes from the band; without it, use `scripts/usage-statusline.mjs` as a statusline. Only Pro/Max plans report usage.

## Benchmark

Seven small tasks, one run each, list-price cost per solved task (Claude Code):

| Strategy | Solved | Cost per solved task |
|---|:---:|---:|
| **model-ladder** | 7/7 | **$0.18** |
| always sonnet / high | 7/7 | $0.13 |
| always opus / xhigh | 7/7 | $0.31 |

Against Opus/xhigh it is 42% cheaper. Against Sonnet on small tasks it costs more and is slower. Large tasks are not measured. Details: [DESIGN.md](DESIGN.md#benchmark).

## Turn features off

| Feature | How |
|---|---|
| Ladder by default | `/plugin configure model-ladder` -> **Use the ladder by default** off, or `MODEL_LADDER_AUTORUN=0` |
| Band | **Show the band** off |
| Usage guard / threshold | Band controls, or `{"usageGuard":{"enabled":false}}` / `{"usageGuard":{"threshold":95}}` |
| Whole plugin | `claude plugin disable model-ladder@model-ladder` |

## Development

Offline suite: `node --test tests/unit/*.test.mjs`. End-to-end: `node tests/e2e/run.mjs [--dry]`.

Design and lessons: [DESIGN.md](DESIGN.md). [MIT License](LICENSE), (c) 2026 neilyonglu. Found a problem? [Open an issue](https://github.com/neilyonglu/model-ladder/issues).
