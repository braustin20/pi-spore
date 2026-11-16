# 0182. revise_lane can move a lane to a new model

- Status: Accepted; changes [0158](0158-revise-lane-is-a-fix-pass.md) for a revise with a model
- Date: 2026-11-15
- Requirements: R4.8, R7.4

## Context

A lane can end up on a model that stops working, for example when a key or a plan goes away. A revise reused the
lane's worker chat, which keeps its model (ADR 0158). When that chat was gone, the lane ran its own pipeline again
with the same stored model. So nothing could move a lane to another model. The coordinator had to let the lane
fail and add a new lane, which lost the lane's workspace and branch.

## Decision

- `revise_lane` takes an optional `model`. Without it, nothing changes from ADR 0158.
- With a model, the revise does not reuse the worker chat, because a reused chat keeps its model. The lane runs its
  own pipeline (`lane.pipeline`) from the first stage with a fresh worker on the new model, in the same lane
  workspace, on the same branch. The coordinator gets a message that says so.
- The new model gets the same checks as the model of a new lane, in the same code: Pi must be able to run it (400
  `unknown_model`), and a tier above the worker role default files a `lane-model` approval (R4.8, ADR 0014). The
  lane then waits in `approval`. Approve makes it `starting` in its workspace. Decline makes it `failed` with a
  message that names the model, keeps its old model, and tells the coordinator, who can revise it again.
- The revise stores the new model in a new column, `runs_lanes.new_model`. `launch` reads it: when it is set,
  `launch` does not reuse the worker and starts the lane's pipeline with `workerModel` set to it. In the same
  commit that marks the lane `running`, `launch` moves `new_model` into `model` and clears it.

## Why a pending column

The card asked for the smallest change, such as a flag that the revise sets and `launch` clears. A column that holds
the pending model is that flag, and it also carries the model. It keeps `model` true until the new model starts:
a declined approval only clears `new_model`, so the lane keeps the model it really ran on. A boolean flag with the
model written at once would need a second place to keep the old model for a decline.

## Consequences

- A lane keeps its workspace, branch, and card when its model stops working.
- A revise with a model costs a full pipeline run, as a gone worker chat does.
- A later revise without a model reuses the new worker chat, which runs on the new model.
