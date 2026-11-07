# 0028. Finding open Unity editors: status, processes, and lock files

- Status: Accepted
- Date: 2026-11-06
- Requirements: R10.3, R10.4, R10.5

## Context

The editor lease (ADR 0011) needs to know which folders of a project have an editor open. A check with a real
editor showed:

- `unity status --json` (CLI 1.0.0-beta.11) lists only editors whose project has the Pipeline package. An open
  project without it gave `data.instances: []`, error `STATUS_NO_INSTANCES`, and exit code 6. Later docs name the
  rows `data.items` and the field `projectPath` (older: `project`).
- `Temp/UnityLockfile` exists while the editor runs, and stays after a crash.
- The editor process has `-projectpath <folder>/` on its command line.

## Decision

- An editor is open on a folder when `unity status` lists it or a process has `-projectpath <folder>`. The lock
  file counts only together with one of them. A lock file alone is shown as stale and does not block.
- Processes come from `/proc` (Linux, the user's platform). Where `/proc` is missing, a lock file alone counts as
  open, and the UI says why.
- `unity status` output is parsed loosely: rows from `data.instances` or `data.items`, the path from `projectPath`
  or `project`. A failed or unreadable status becomes a warning; the other signs still count.
- The lease is reconciled whenever it is read, not on a timer.
- Archive refuses to remove a folder that has an editor open, even when forced.

## Consequences

- An editor opened outside pi-spore is seen as long as it runs, with or without the Pipeline package.
- Whether `unity close` can close an editor without the Pipeline package is not checked yet (see Q17). If it
  cannot, the UI shows the error and the user closes Unity by hand.
- On another platform, a stale lock file blocks until the user deletes it.
