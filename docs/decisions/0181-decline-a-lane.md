# 0181. The coordinator or the user declines a lane that will not merge

- Status: Accepted
- Date: 2026-11-15
- Requirements: R7.1 to R7.6
- Builds on: [ADR 0150](0150-run-worktree-and-green-merges.md), [ADR 0151](0151-run-cancel-handover-and-pr-approval.md),
  [ADR 0100](0100-agent-cards-and-approvals.md), [ADR 0029](0029-web-ui-stack.md)

## Context

`open_run_pr` needs every lane `merged` or `declined` (ADR 0151). Only a declined model approval made a lane
`declined`. A lane that failed, and whose work the coordinator redid in a new lane, stayed `failed`. `revise_lane`
was the only way out, and it reruns the lane. So the run could never open its PR.

## Decision

1. **`decline_lane { laneId, reason }`** is a coordinator tool (bridge `POST /api/bridge/lanes/decline`). The user
   declines a lane from the Runs page (`POST /api/runs/:id/lanes/:laneId/decline` with `{ reason }`). Both set the
   lane to `declined` with the reason as its message.
2. **Allowed states: `waiting`, `passed`, `failed`.** Every other state answers 409 `lane_not_declinable` and names
   the state. A cancelled run answers 409 `run_cancelled`.
   - `approval` is refused: the approvals interface (ADR 0100) cannot close an open approval as moot, so a decline
     would leave a dead approval on Home. The user drops such a lane by declining its model approval, as before.
   - `starting` and `running` are refused: a decline would have to stop the lane's pipeline. `merging` is refused:
     a merge in progress finishes or fails first.
3. **A decline merges nothing and deletes nothing.** The lane's workspace and branch stay. A waiting lane's lane job
   is cancelled. Lanes that waited on the declined lane are woken; a declined lane does not block a wave.
4. **The coordinator may decline without asking the user.** The run PR approval shows the user each declined lane
   and its reason, so dropped work is visible before the PR opens.
5. **The coordinator hears of it.** A user decline delivers a short message to the coordinator. When a decline
   leaves every lane of a `running` run merged or declined, with at least one merged, the coordinator gets the same
   "call open_run_pr" line a merge sends.

## Consequences

- A run with a failed and replaced lane can finish.
- A lane in `approval`, `starting`, or `running` cannot be declined. Declining a running lane is future work.
