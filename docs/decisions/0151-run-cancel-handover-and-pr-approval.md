# 0151. A run can be cancelled, follows the active chat, and opens its PR on the user's approval

- Status: Accepted; changed by [0157](0157-finished-run-follows-the-active-chat.md) and
  [0165](0165-finished-run-pushes-each-merge.md) for finished runs
- Date: 2026-11-08
- Requirements: R7.1 to R7.6, R9.3, R15

## Context

ADR 0150 left three gaps. A bad run could not be stopped. A new worker chat in the run workspace (ADR 0030) left
the run pointing at a read-only chat, so lane reports and questions went nowhere. And the user had to open the
run's PR by hand from the PR tab.

## Decision

- **Cancel.** The user cancels a run. Its coordinator, lane pipelines, lane agents, lane and merge jobs, and a merge
  in progress stop, through the same stop paths archiving and the pipelines module use. A merge in progress aborts,
  so the run worktree is clean. Unmerged lanes become `cancelled`; merged lanes stay. Pending deliveries to the
  stopped chats are dropped. Nothing is deleted, merged, pushed, or opened. A cancelled run takes no lane tool calls.
- **Handover.** The active worker chat of a running run's workspace is its coordinator. When it changes, the new
  chat gets a handover of the run first, then the old chat's pending deliveries. A cancelled or finished run keeps
  its coordinator.
- **Run PR by approval.** This replaces "the user opens the one PR from its PR tab" in ADR 0150. When every lane is
  merged or declined, the coordinator calls `open_run_pr`, which files a `run-pr` approval (ADR 0100). On approve,
  the runs module opens the PR through the github-pr module, with the run line as head and the run's base. The user
  may edit the title and body. The run is then `finished`. Nothing merges the PR but a human (ADR 0130).

## Consequences

- The github-pr module sets the runs module's PR opener, so runs does not depend on it (kanban requires runs).
- A run has a state: `running`, `cancelled`, or `finished`.
- Approvals a lane's pipeline filed before a handover still answer the old chat.
