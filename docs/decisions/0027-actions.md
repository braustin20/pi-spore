# 0027. Actions: argv commands, setup and teardown hooks, a queue for exclusive runs

- Status: Accepted
- Date: 2026-11-06
- Requirements: R2.7, R12

## Context

Projects need named commands (`test`, `dev`), and new copies need a setup step before work starts. Commands can run
for a long time (a dev server), start child processes, and must be cancellable. The workspaces module creates and
removes copies; the actions module must not reach into it.

## Decision

- Actions are `[actions.<name>]` tables in the project file or the local override. The local override replaces a
  whole action of the same name. `run` is an argv array; a string is allowed only with `shell = true`, and then runs
  as `/bin/sh -c <run>`. Unknown keys and model keys are rejected (architecture 13).
- A run is a child process started with `spawn` and an argv array (no shell unless `shell = true`), in its own
  process group, with stdout and stderr written to `~/.pi-spore/logs/actions/<workspace id>/<run id>.log`.
  `spawn` is used instead of `execFile` because the output streams to the log and the run can be cancelled.
- Cancel sends SIGTERM to the process group, then SIGKILL after 5 s. When the server process exits, it sends
  SIGTERM to every live group. On start, runs that were queued or running are marked `interrupted`.
- `exclusive` runs wait in line per folder: a second exclusive run in the same folder is `queued` and starts when
  the first ends. Non-exclusive runs never wait.
- The workspaces module exposes `afterCopyCreated` and `beforeRemoveCopy` hooks. Each returns a step report.
  - `setup` runs after a new copy is made and its copy list is done. A failed setup keeps the workspace; the create
    response lists it in `steps`.
  - `teardown` runs on archive before the copy is removed. A failed teardown answers 409 `teardown_failed`.
    Archiving with `force` runs teardown again and removes the copy even if it fails. `force` also removes
    uncommitted work, and the UI says so.
  - Workspaces in the main checkout run neither, because no copy is made or removed.
- Archiving cancels the workspace's open runs first.
- Clients follow a run through a long poll on its log (`?from=<byte>&wait=<ms>`), not the event hub.

## Consequences

- `teardown` should be safe to run twice: a refused archive (uncommitted work) can run it before the copy stays.
- Exclusive queues live in memory. A restart marks queued runs `interrupted`; they do not start by themselves.
- Programs that leave their process group (setsid, double fork) are not stopped by cancel.
- A server killed with SIGKILL leaves its runs' process groups running.
