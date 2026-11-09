# 0153. Unity test gates run in batch mode behind the editor lease, and close falls back to `--force`

- Status: Accepted
- Date: 2026-11-08
- Requirements: R10.5, R10.6, R6.5

## Context

ADR 0011 promised batch-mode test gates. Unity refuses batch mode on a folder while an editor has it open. A gate
therefore has to wait for an editor or close it, and closing discards unsaved work (R10.5). Q17 asked whether
`unity close` works on an editor whose project has no Pipeline package. The spike (`docs/spikes/q17-unity-close.md`)
shows it does not: it exits 6 with `pipeline_missing` and leaves the editor running. `--force` ends the process.

Pipeline gates are action names (ADR 0016), and an action is a process from `config.toml`. A Unity gate also needs a
wait before the process and a copy of the report after it.

## Decision

- **Q17.** `close` runs `unity close --json <path>`. If it fails with `PROJECTS_CLOSE_PIPELINE_MISSING`, it runs
  again with `--force`. It reads the `errors[].code` of the JSON output and compares it exactly; other failures and
  output that is not that JSON are shown as before and nothing is retried. Callers already hold the user's
  yes, and a graceful close does not save either.
- **Provided actions.** The actions module lets a module add an action for projects with a trait
  (`Actions.provide`). It is a normal run (process, log, cancel, exclusive per folder), but the module runs a
  `prepare` step first (wait, then name the command) and an `after` step when the process has exited. A project
  action of the same name replaces it. Pipelines and runs need no change: they already start gates by action name.
- **Gates.** The unity module provides `unity-test-editmode` and `unity-test-playmode` for Unity projects. Each
  runs `unity test <folder> --mode <mode> --output <tmp file> --timeout 1800` with an argv array. `after` stores the
  report as the workspace artifact `unity-tests/<run id>.xml`. Exit code 0 with no report fails the gate, and a
  failed run keeps the log, which the pipeline tails (R6.5). The temp report file is removed on every end, also on
  cancel and timeout.
- **Deadline.** The CLI's `--timeout` was read from `--help` only, so the runner also has its own deadline for a
  provided action (`timeoutMs`): 31 minutes. Past it, the process group gets SIGTERM, then SIGKILL, and the run
  fails with "Timed out".
- **Lease handoff.** Before the process, the gate looks at the editors on this workspace's folder every 5 s:
  - no editor: go on;
  - an agent holds the lease: wait;
  - anything else (the user's lease, or an editor opened outside pi-spore): file a `unity-close-editor` approval on
    Home for the workspace's active chat. Approve looks again first: if the editor is gone or an agent holds it now, nothing is closed. Otherwise
    it closes the editor without saving, and the gate goes on. Decline
    fails the gate. A replaced subject on approve is refused (422), so only the folder asked about can be closed.
    A question left open by a cancelled gate is asked again by the next gate for that folder, not filed twice. If an
    approve closed nothing and the user's editor is open again, the gate files a new question. If the user quits Unity by hand, the gate goes on without an answer.
  - Cancelling the run ends the wait. The gate never closes an editor without an approve (R10.5).
- Editors on other folders of the project do not block: batch mode locks only its own folder.

## Consequences

- The unity module now requires `actions`, `agents`, `artifacts`, and `attention`.
- An approval left open after its gate ended does nothing when approved. A server restart forgets which approvals
  are open, so the next gate files a new one.
- The approval goes to the workspace's active worker chat, which is created if there is none, as pipelines do.
- A project pipeline lists `unity-test-editmode` or `unity-test-playmode` in a gate stage.
- Nothing stops a user from opening the editor on the folder while a test runs; Unity then fails one of the two.
