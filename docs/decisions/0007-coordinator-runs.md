# 0007. Coordinator runs over lanes in waves

- Status: Accepted
- Date: 2026-11-06
- Requirements: R7.1, R7.2, R7.3

## Context

Large changes are split into lanes by hand today. Lanes that share types must wait for a contract lane.

## Decision

A run is a coordinator conversation that owns lane workspaces in a wave graph: a contract wave first when needed,
then independent lanes in parallel. The coordinator settles the spec, writes briefs to artifacts, starts lanes,
answers questions, reads diffs and reports, runs gates, and merges into the integration branch. A workspace can
run a pipeline without a run.

## Consequences

- Runs are the largest v1 feature. They build on workspaces and pipelines, so they come last in the build order.
