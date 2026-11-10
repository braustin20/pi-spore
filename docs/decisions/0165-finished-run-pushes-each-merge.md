# 0165. A merge into a finished run is pushed to its open PR

- Status: Accepted; changes [0151](0151-run-cancel-handover-and-pr-approval.md) and
  [0157](0157-finished-run-follows-the-active-chat.md) for finished runs
- Date: 2026-11-09
- Requirements: R7.3, R9.3

## Context

ADR 0157 lets a new chat coordinate a finished run and start more lanes, for example to fix a conflict with the
base. Two gaps were left. When the last lane merged, the coordinator was told to call `open_run_pr`, which answers
409 `run_finished` because the PR is open. And `merge_lane` merges into the run line in the run worktree only, so
the open PR did not show the new merges until the user pushed by hand. Seen in run `01M6YSQ7CXAENRC4C561NBPCS7`.

Pushing the run line was the user's call. ADR 0151 pushes it only when the user approves `open_run_pr`. On
2026-11-09 the user chose an automatic push after each green merge into a finished run, over giving the coordinator
`push_line`.

## Decision

- When a lane merges into a `finished` run, the `runs.merge` job's `finish` step pushes the run line with the VCS
  `publish` push, after the gates pass and the merge commit is made. The push never forces. The user's approval of
  the run PR is their yes to this branch on GitHub; this push only updates that PR.
- The message to the coordinator says the lane is merged and that pi-spore pushed the run line, so the open PR shows
  it. It never tells the coordinator of a finished run to call `open_run_pr`.
- A failed push does not undo the merge. The lane stays `merged`, and the message names the error and says the PR
  does not show the merge.
- A running run is not pushed: its line first goes to GitHub when the user approves `open_run_pr` (ADR 0151).
- pi-spore never merges the run PR and never turns on auto-merge (ADR 0130, ADR 0142).

## Consequences

- The open PR of a finished run follows its run line with no step from the user or the coordinator.
- A push rejected because the remote line moved needs a person or a new lane to merge it in. pi-spore does not
  retry it.
