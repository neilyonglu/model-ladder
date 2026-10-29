# Agent rules

- Put temporary files (screenshots, scratch scripts, request JSON, draft copies, verification output) in the system temp directory under `model-ladder/<repo hash>/` (`artifactDir(root)` in `scripts/common.mjs`). Never put them in the repo or in `.model-ladder/`.
- `.model-ladder/` holds only `runs/`, `history.jsonl`, `live.json`, `usage.json`, `context.json` and `HANDOFF.md`.
- Locally run only the test files related to your change; GitHub CI runs the full suite.
