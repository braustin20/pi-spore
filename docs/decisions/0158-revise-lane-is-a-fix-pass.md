# 0158. revise_lane is a short fix pass

- Status: Accepted; changes [0150](0150-run-worktree-and-green-merges.md) for `revise_lane`
- Date: 2026-11-09
- Requirements: R6.2, R6.3, R4.4, R7.4

## Context

ADR 0150 said `revise_lane` starts a new pipeline run in the lane workspace. That run began at the first stage. In
the first real run, lane `diff-comments-composer` ran its whole pipeline three times: implement, two review rounds,
adversarial, gates. Two of those came from `revise_lane`. A small ask from the coordinator, such as a cut, a
conflict, or a red gate after a merge, cost a fresh worker with no context and three fresh reviewers.

## Decision

- A revise is a short fix pass, run by the built-in pipeline `revise`. A user or project file with id `revise`
  replaces it, as for `default` (R6.2):
  1. `fix`: the lane's existing worker chat gets the new brief. It keeps its context.
  2. `review`: one fresh reviewer, one round, `min_strength_over = "fix"` (R4.4). It gets the brief, the last review
     of the lane's previous pipeline run, the whole diff, and a fix diff (the commits since the revise started, then
     the uncommitted and untracked files). It checks that the brief's asks are met and that nothing broke. It
     answers REVISE only for a bug, a missing or wrong test, a regression, or a break of the brief, the same rule
     as round 2 of a review stage.
  3. `gates`: `check` and `test`, with `fail_first = "artifact"`.
- No adversarial stage and no second round. A REVISE gets one last fix with no review after it (`fix_passes = 1`),
  then the gates. No round-limit question.
- A worker stage may set `worker = "reuse"`. It makes no agent: it gives the brief to the worker of the run named by
  `StartRunRequest.previousRunId`, in the same workspace. The key exists because a pipeline file is the place where
  stages are declared; the alternative was special-case code in the runs module. A reuse stage takes no `model` or
  `tier`, because the reused chat keeps its model. A reuse pipeline needs `previousRunId`; any other pipeline
  refuses it.
- Pipeline runs never stop or close their agents, and a delivery starts a stopped agent, so a worker can serve a
  later run.
- The runs module reads the lane's previous run with `Pipelines.get(runId)` and its `workerAgentId`. When that chat
  is gone (deleted or closed), the lane runs its own pipeline from the first stage, as before, and the coordinator
  gets a message that says so.

## Consequences

- A revise costs one worker turn, one review, and the gates, plus at most one fix.
- The lane's worker chat grows over revises. A gone chat falls back to a full run with a fresh worker.
- The fix diff starts at the lane's head when the revise starts, so it also shows files the worker left
  uncommitted before.
