# model-ladder verification map

Run commands from the repository root. Node 20+ and Git are required. Offline
harnesses use isolated temporary repositories and fake only the model process;
they must not operate on an active user run. Evidence belongs under the helper's
printed `artifactDir/verification/<run-id>/` directory and survives cleanup.

- [Run and verify a task](run-task.md) covers routing, retries, verification,
  application, and the separate Claude workflow path.
- [Panel and handoff](panel-handoff.md) covers status, guard controls, active-run
  handoff, and checkpoint resume instructions.
- [Safety and recovery](safety-recovery.md) covers dirty consent, protected files,
  usage stops, timeout recovery, and retained state.

Record which entry point was exercised. Offline CLI proof does not cover live
model access or the Claude host UI. For every journey retain the command, both
output streams, exit code, and resulting state checked by the harness. Report
skipped or unreachable entry points explicitly.
