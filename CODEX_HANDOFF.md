# Codex handoff: finish Codex automation fixes

This work repairs model-ladder itself. Do not run the ladder recursively.

## State

The fixes are implemented in this checkout but not committed. They touch `scripts/codex-run.mjs`, `scripts/codex-exec.mjs`, the Codex skill, README, CHANGELOG, the fake Codex CLI and the tests. Run `git diff` to see them.

- Offline suite `node --test tests/unit/*.test.mjs` passed 101/101.
- `git diff --check` passed.
- The native smoke test has not passed yet. The last attempt stopped at the router because the Codex usage limit was reached.

## TODO

- [ ] Run `node tests/e2e/codex-smoke.mjs`. It uses the production Sol router and verifier with a Luna worker. If it reports "Could not find home directory", run it outside the outer tool sandbox.
- [ ] If the smoke test fails, inspect the retained fixture under `%TEMP%/model-ladder-live-*/.model-ladder/`. An earlier Luna-verifier fixture (`model-ladder-live-ioHFwn`) and a Codex-home failure fixture (`model-ladder-live-7zkTCa`) are stale and can be deleted.
- [ ] After the smoke test passes, sync the changes to the installed plugin cache at `C:/Users/lushi/.codex/plugins/cache/model-ladder/model-ladder/1.0.0`.
- [ ] Commit. Bump the version or release if needed. Delete this file.

## Rules

- Keep the sandbox and approval controls. Do not add bypass flags.
- Do not change global user settings. Host sandbox ACL setup and plugin hook errors are external environment issues.
