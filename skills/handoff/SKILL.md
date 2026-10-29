---
name: handoff
description: Write .model-ladder/HANDOFF.md yourself from this whole conversation, so another session or model can continue the work. Use for /model-ladder:handoff or when the user asks to hand off, save progress or write a handoff file.
argument-hint: [note]
---

# model-ladder handoff

Extra note from the user (may be empty): $ARGUMENTS

You write `HANDOFF.md`. The program-generated template lacks what only this session knows: what the user asked for and prefers, what was decided, and what to do next. Do not run the ladder, the Workflow tool or any model-ladder runner here. Run commands from the repository root.

## 1. Template data

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/finish.mjs" --handoff`. It writes `.model-ladder/HANDOFF.md` from the last run in `.model-ladder/history.jsonl`: task, attempts with PASS/FAIL, status, kept worktree, resume command. Read the file it wrote. If it says there is no run history, there is no appendix; skip step 3's appendix.

## 2. Rewrite HANDOFF.md

Overwrite `.model-ladder/HANDOFF.md` with the Write tool. Use your whole conversation with the user, not only the template. Write in the language the user uses in this session; keep file names, commands, paths, model names and status codes as they are. Start with `# model-ladder handoff (AI-written)` and these sections, in order:

1. `## Goal`: what the user is trying to achieve, in their terms.
2. `## User preferences and decisions`: constraints, preferences, corrections and choices the user made, and why. Only what the conversation shows.
3. `## Done and not done`: finished work (say what was verified and how), unfinished work, failed approaches and cautions.
4. `## Suggested next steps`: concrete, in order.
5. `## How to resume`: the exact command, for example `/model-ladder:run <task>`, and any worktree or patch to look at first.

State what you know from the conversation as fact and what you only infer as inference. Do not invent results.

## 3. Appendix: program-generated data

After the AI sections, add the heading `## Appendix: program-generated verification (authoritative)` with one line saying this part was written by the model-ladder script, not by you, and that its PASS/FAIL results and status win over anything above. Then paste the template from step 1 unchanged, minus its first `# model-ladder handoff` title line: attempts PASS/FAIL, status, worktree, resume command and any model context. The split must stay clear: your sections are the AI-written account, the appendix is the authoritative record.

## 4. Report

Tell the user, in their language, the path of `HANDOFF.md` and that it has AI-written sections plus a program-generated appendix.
