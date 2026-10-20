<div align="center">

# 🪜 model-ladder

**Start every coding task on the cheapest model that can do it. Climb only when your tests say so.**

[![test](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml/badge.svg)](https://github.com/neilyonglu/model-ladder/actions/workflows/test.yml)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![release](https://img.shields.io/github/v/release/neilyonglu/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![vs opus/xhigh](https://img.shields.io/badge/vs%20opus%2Fxhigh-42%25%20cheaper-brightgreen)](#-is-it-worth-it-for-you)

[Install](#-install) · [Use](#-use) · [How it works](#-how-it-works) · [Benchmark](#-is-it-worth-it-for-you) · [Configure](#-configure) · [Design](DESIGN.md)

</div>

---

model-ladder is a plugin for coding agents. It runs on [Claude Code](https://code.claude.com) today; Codex support is planned. It runs your task on a cheap model at low effort in an isolated git worktree, checks the result with your own tests, and moves up a model × effort grid only when an attempt fails. A router decides each move from what actually went wrong, and code makes sure it only ever moves up.

```text
/model-ladder:run Fix the typo in the welcome message
```

```text
model-ladder ── VERIFIED

Task      Fix the typo in the welcome message
Verify    uv run pytest tests/test_messages.py
Tests     protected (router: Bug fix; the existing test defines expected behavior.)
Start     haiku/low (router: One-character typo "Wellcome" in shop/messages.py; existing test already asserts the correct text.)

#  Model / Effort   Result   Why next
1  haiku / low      PASS     —

Changed   shop/messages.py
Applied   to the working tree (not committed)
Tokens    3228 output (route + attempts)
```

## ✨ Features

- **Cheap first.** Starts at the lowest cell likely to succeed, not the strongest model "to be safe".
- **Verified, not claimed.** Only a change that passes your tests reaches your working tree.
- **Smart escalation.** Raises effort when the worker was close, switches model when it lacked knowledge, and stops when the problem is the environment or an unclear task.
- **Anti-cheat.** Workers cannot edit your tests or the ladder config to make a run pass.
- **Safe by default.** Every attempt runs in a throwaway worktree. Nothing is committed unless you ask, and nothing is ever pushed.
- **Tunable per project.** One optional JSON file sets the grid, and every run is logged so you can see where it climbs.

## 📊 Is it worth it for you?

Seven small tasks (from a typo to "implement this spec"), one run each, list-price cost reported by Claude Code:

| Strategy | Solved | Cost per solved task |
|---|:---:|---:|
| **model-ladder** | 7/7 | **$0.18** |
| always sonnet / high | 7/7 | $0.13 |
| always opus / xhigh | 7/7 | $0.31 |

> [!TIP]
> **You run everything on Opus or a high effort?** model-ladder solved the same tasks for **42% less**.

> [!NOTE]
> **You already run Sonnet on small tasks?** model-ladder costs more and is slower. Orchestrating a run costs about one extra session, and on small tasks that is more than a cheaper worker saves. Large tasks, where a fixed run costs the most and the overhead matters least, are not measured yet.

Cost breakdown and caveats: [DESIGN.md › Benchmark](DESIGN.md#benchmark).

## 🧭 How it works

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

The grid it climbs:

```text
          low   medium   high   xhigh
haiku      ●      ●       ●
sonnet     ●      ●       ●
opus       ●      ●       ●       ●
```

A move only goes up: a higher effort within the same model (opus one step at a time), or the next model at any effort. It never skips from haiku straight to opus.

| Role | Runs on | Does |
|---|---|---|
| Router | sonnet / low, read-only | Picks the start, finds your verify step, diagnoses each failure |
| Worker | the current cell | Implements the task in a fresh git worktree |
| Verifier | haiku / low | Checks protected files, runs your tests |

## 📦 Install

```text
/plugin marketplace add neilyonglu/model-ladder
/plugin install model-ladder@model-ladder
```

Where `/plugin` is not available, such as the Claude Code extension for VS Code, install from a terminal instead. The extension shares the same settings; reload its window afterwards.

```sh
claude plugin marketplace add neilyonglu/model-ladder
claude plugin install model-ladder@model-ladder
```

**Requirements**

- Claude Code with the Workflow tool (paid plans; on Pro, enable it in `/config`). Tested on 2.1.296.
- git, and Node.js 20 or later on `PATH`.
- A git repository with at least one commit.

**Recommended**

Add model-ladder's working folders to `.gitignore`:

```text
.model-ladder/
.claude/worktrees/
```

Skip the approval prompt for each run by allowing the Workflow tool, for example in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Workflow"] } }
```

**Updates**

Claude Code does not auto-update plugins from third-party marketplaces unless you turn it on: `/plugin` → **Marketplaces** → **model-ladder** → **Enable auto-update**. Otherwise update by hand:

```sh
claude plugin update model-ladder@model-ladder
```

Either way, the end of a model-ladder report tells you when a newer version is out. What changed in each version: [CHANGELOG.md](CHANGELOG.md). To get notified on GitHub, **Watch** → **Custom** → **Releases**.

## 🚀 Use

```text
/model-ladder:run <task>
```

model-ladder asks before it acts when:

- you have uncommitted changes (it can build on them; they are never part of its patch),
- the task is too vague to act on,
- the repo has no tests for the task, so you confirm what "done" means,
- `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since either overrides every attempt's model or effort.

## 🔧 Configure

Optional, per project: `.claude/model-ladder.json`. Each key you set replaces its default.

| Key | Default | Meaning |
|---|---|---|
| `router` | `{ "model": "sonnet", "effort": "low" }` | Picks the start, diagnoses failures |
| `verifier` | `{ "model": "haiku", "effort": "low" }` | Runs the verify command (the router's model judges when there is none) |
| `tiers` | haiku low–high, sonnet low–high, opus low–xhigh | The grid, weakest model first; `maxEffortJump` caps effort steps per move (2, 2, 1) |
| `maxAttempts` | `4` | Attempts before giving up |
| `verify` | found by the router | Command that proves the task is done |
| `protected` | `[]` | Extra globs no worker may modify |
| `commit` | `false` | Commit the verified change |
| `keepFailed` | `false` | Keep failed attempts' worktrees for debugging |

<details>
<summary>Example: a three-rung ladder that commits</summary>

```json
{
  "tiers": [
    { "model": "haiku",  "efforts": ["low"],           "maxEffortJump": 1 },
    { "model": "sonnet", "efforts": ["medium", "high"], "maxEffortJump": 1 },
    { "model": "opus",   "efforts": ["high"],           "maxEffortJump": 1 }
  ],
  "verify": "npm test",
  "commit": true
}
```

</details>

Models are aliases (`haiku`, `sonnet`, `opus`), so new model versions are picked up automatically.

Every run appends a line to `.model-ladder/history.jsonl`: which cells were tried, why each move was made, and the tokens spent. Use it to tune the grid, for example to start at haiku/medium if haiku/low keeps failing.

## 🛡️ Safety

- Workers run in throwaway git worktrees. Only a verified change reaches your working tree, and it is never committed unless `commit` is true. Nothing is ever pushed.
- Workers may not touch tests unless the task is about tests, and never the ladder config. A hook blocks such edits as they happen, and the verifier rejects any that slip through.
- If you edit the same files while a run is going, the change is not forced in; the worktree and patch are kept and the report says where.

## ⚠️ Limitations

- Claude Code only for now.
- Orchestration costs about one session per run regardless of task size.
- Token counts in the report cover the router, workers and verifier, not the orchestrating session.
- The benchmark is seven small tasks with one run each.

## 🧪 Development

```sh
node --test tests/unit/*.test.mjs            # 45 unit tests, no dependencies, no model calls
node tests/e2e/run.mjs --dry                 # plant every scenario and run pytest, no model calls
node tests/e2e/run.mjs [scenario ...]        # end-to-end via claude -p (about $0.2 per scenario)
node tests/e2e/bench.mjs                     # 7 tasks x 3 strategies (about $4.5)
```

The end-to-end scripts need `claude` and `uv` on `PATH`. Design decisions, spike results and lessons from real runs are in [DESIGN.md](DESIGN.md).

## 🙏 Credits

The brief format and the "verifier on a fresh context" rule are adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (MIT).

## 📄 License

Released under the [MIT License](LICENSE). Copyright (c) 2026 neilyonglu.

Built in collaboration with Claude Code. Found a problem? Please [open an issue](https://github.com/neilyonglu/model-ladder/issues). Codex support is planned.
