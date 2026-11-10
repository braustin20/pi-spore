# 0157. A finished run follows the active chat too

- Status: Accepted; changes [0151](0151-run-cancel-handover-and-pr-approval.md) for finished runs; changed by
  [0165](0165-finished-run-pushes-each-merge.md)
- Date: 2026-11-09
- Requirements: R7.3

## Context

ADR 0151 said a cancelled or finished run keeps its coordinator when the user starts a new chat in the run
workspace. A finished run still takes lane tool calls, and its PR can need more work, such as a conflict with its
base. In run `01M6YSQ7CXAENRC4C561NBPCS7` the user started a new chat to fix PR #40. That chat had the coordinator
tools and started a lane. The lane failed its test gate. The `runs.lane` job wrote the failure to the old chat. A
delivery to a chat that is not the active worker chat waits until that chat is active again, so the coordinator
never got it and the run stalled.

## Decision

- When the active worker chat of a finished run's workspace changes, the new chat becomes the coordinator, as for a
  running run: it gets the handover first, then the old chat's pending deliveries. The handover says the run's PR is
  open.
- A cancelled run still keeps its coordinator. It takes no lane tool calls, so nothing is sent to it.

## Consequences

- Lane reports, failures, and questions of a finished run reach the chat the user works in.
- Lane tools still take a finished run. ADR 0165 pushes its new merges to the open PR and stops telling the
  coordinator to call `open_run_pr`.
