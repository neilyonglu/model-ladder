<div align="center">

# 🪜 model-ladder

**Start every task on the cheapest model that can do it. Climb only when your tests say so.**

[![test](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml/badge.svg)](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![release](https://img.shields.io/github/v/release/neilyonglu/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![vs opus/xhigh](https://img.shields.io/badge/vs%20opus%2Fxhigh-42%25%20cheaper-brightgreen)](#benchmark)

[Install](#install) · [Use](#use) · [How it works](#how-it-works) · [Configure](#configure) · [Band](#band-claude-code) · [Usage guard](#usage-guard) · [Benchmark](#benchmark) · [Turn off](#turn-features-off) · [Design](DESIGN.md)

</div>

---

A plugin for [Claude Code](https://code.claude.com) and Codex. It runs your task on a cheap model at low effort in an isolated git worktree, checks the result with your own tests, and moves up a model x effort grid only when an attempt fails. A router decides each move from what went wrong; code guarantees it only goes up.

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

## Use

Claude Code: `/model-ladder:run <task>`. Codex: ask for the `model-ladder` skill. By default (both runtimes) every top-level task, of any kind, goes through the ladder (outside a git repo the assistant says it needs one and does the task directly); say "no ladder" to skip.

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

Verify is your test command, Tests says whether workers may edit tests, each table row is one attempt, and the change lands in your working tree uncommitted. It asks first when you have uncommitted changes, the task is vague, no tests exist, or `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set. Small tasks in a very long Claude session (>~300k tokens) are done directly; `--ladder` forces the ladder.

Codex runner directly: `node scripts/codex-run.mjs "<task>"` (or JSON on stdin / `--input file.json`: `task`, `acceptance`, `allowDirty`, `resumeRun`). Only `VERIFIED` exits 0; `DIRTY`, `NEEDS_INPUT`, `STALE_RUN` exit 2; failures exit 1. Put input files in `.model-ladder/` or outside the repo. Watch it live with `node scripts/watch.mjs [--cwd <repo>]`.

## How it works

```mermaid
flowchart LR
    T([Task]) --> R[Router<br/>picks a start cell]
    R --> W[Worker<br/>fresh worktree]
    W --> V{Verifier<br/>tests pass?<br/>tests untouched?}
    V -- yes --> A([Apply to your<br/>working tree])
    V -- no --> D[Router<br/>diagnoses]
    D -- raise effort / model --> W
    D -- environment or<br/>unclear task --> S([Stop and explain])
```

- Grid (Claude): haiku low-high, sonnet low-high, opus low-xhigh. A move only goes up: higher effort in the same model, or the next model at any effort. Never skips a model.
- Router (sonnet/low) picks the start, finds your verify step, diagnoses failures. Worker runs in a fresh git worktree. Verifier (haiku/low) checks protected files and runs your tests.
- Anti-cheat: workers cannot edit tests (unless the task is about tests) or the ladder config; a hook blocks it and verification re-checks.
- Only a verified change reaches your working tree; never pushed, committed only if `commit` is true. If you edit the same files mid-run, the patch is kept and the report says where.
- Codex uses the same rules with its own models: router `gpt-5.6-terra/low`, verifier `gpt-6-luna/low`, tiers Luna, Terra, Sol (replace with models your account has). It has no `DIRECT` shortcut or `commit` option, and verifies completion with a separate model after your tests pass.
- Interrupted Codex runs keep a draft; add the returned `resumeRun` to the original input and rerun. `timeoutMs` is an idle limit, not a deadline.
- Every run appends to `.model-ladder/history.jsonl` (cells tried, why, tokens) so you can tune the grid.

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

Models are aliases (`haiku`, `sonnet`, `opus`), so new versions are picked up automatically. Codex defaults are listed above in How it works; its `tiers` use `efforts` and `maxEffortJump` the same way. Without `verify`, Codex uses `.agents/skills/verify/SKILL.md` or `.claude/skills/verify/SKILL.md` if present, else an existing npm, pytest, Cargo, Go, Maven or Make test command; with none it needs explicit acceptance criteria.

Plugin options (`/plugin configure model-ladder`): `autoRun` (use the ladder by default) and `band` (show the band), both on. `worker_skills` and `verifier_skills` are comma-separated skills those roles load before working (e.g. `ponytail:ponytail`); the band shows them as `with: …`.

## Band (Claude Code)

A band above the prompt shows each running ladder agent and the usage guard. Needs Claude Code 2.1.290+; works in the terminal, desktop app and VS Code.

<p align="center"><img src="assets/band.png" width="505" alt="The model-ladder band, idle: 5-hour usage 10%, weekly 44%, usage guard on at 90%."></p>

```text
▴ model-ladder ── 2h/5h 15% · 3d/7d 44%
model/effort        time     task
haiku-5.5/low       ✓ 5s     Summarize the README install steps
[usage guard: on]  threshold [90] % [set]
```

The header shows subscription usage as `<time to reset>/<window> <percent>` (`idle` when nothing runs; `▴`/`▾` folds it). Finished rows leave after 10 seconds. A `handoff now` button writes `.model-ladder/HANDOFF.md` for the current or last run. `usage guard` and `threshold` write `.claude/model-ladder.json` and apply from the next run. Codex has the same table in the terminal via `scripts/watch.mjs` (`--guard on|off`, `--threshold 1-100`), fed by `.model-ladder/live.json`.

## Usage guard

On by default. A run does not start, and stops after a failed attempt, once the 5-hour or weekly limit reaches `threshold` (default 90%). It returns `USAGE_LIMIT`, keeps the last worktree and writes `.model-ladder/HANDOFF.md`; rerun after the reset. A running attempt is never interrupted; unknown usage never blocks. Claude usage comes from the band (`.model-ladder/usage.json`; readings older than 15 minutes count as unknown); without the band or on an API key, use `scripts/usage-statusline.mjs` as a statusline. Codex reads the latest local session's quota. Only Pro/Max plans report usage.

## Benchmark

Seven small tasks, one run each, list-price cost per solved task (Claude Code):

| Strategy | Solved | Cost per solved task |
|---|:---:|---:|
| **model-ladder** | 7/7 | **$0.18** |
| always sonnet / high | 7/7 | $0.13 |
| always opus / xhigh | 7/7 | $0.31 |

Against Opus/xhigh it is 42% cheaper. Against Sonnet on small tasks it costs more and is slower, because orchestration costs about one extra session per run. Large tasks are not measured; Codex cost is not inferred from this. Details: [DESIGN.md](DESIGN.md#benchmark).

## Turn features off

| Feature | How |
|---|---|
| Ladder by default | `/plugin configure model-ladder` -> **Use the ladder by default** off, or `echo '{"autoRun":"false"}' \| claude plugin configure model-ladder@model-ladder --values-stdin`; either runtime: `MODEL_LADDER_AUTORUN=0` (Codex also: leave its hook untrusted) |
| Band | **Show the band** off, or `echo '{"band":"false"}' \| claude plugin configure model-ladder@model-ladder --values-stdin` |
| Usage guard / threshold | Band controls, or `{"usageGuard":{"enabled":false}}` / `{"usageGuard":{"threshold":95}}` |
| Whole plugin | `claude plugin disable model-ladder@model-ladder` |

## Development

Offline suite: `node --test tests/unit/*.test.mjs`. End-to-end: `node tests/e2e/run.mjs [--dry]`, `bench.mjs` (about $4.5), `codex-live-smoke.mjs` (offline monitor demo), `codex-smoke.mjs` (real model call).

Design and lessons: [DESIGN.md](DESIGN.md). Brief format and fresh-context verifier adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (MIT). [MIT License](LICENSE), (c) 2026 neilyonglu. Found a problem? [Open an issue](https://github.com/neilyonglu/model-ladder/issues).
