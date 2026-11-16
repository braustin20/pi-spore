# 0188. An agent graph step says how it ended, or why it waits

- Status: Accepted; extends [0176](0176-live-agent-graph.md) ("Shapes")
- Date: 2026-11-16
- Requirements: R6 (pipelines), R15 (attention)

## Context

A finished review step in the agent graph said only `idle · sonnet 5.5`. The user could not see whether the reviewer
approved or asked for a revise. A step that was blocked, or that waited for an answer, looked like plain `working`.

## Decision

- `GraphStep` (`packages/shared/src/agent-graph.ts`) gets three optional fields. `state` does not change, so the
  layout and the pod states do not change.
  - `outcome`: `approved`, `revise`, `reported`, `passed`, `blocked`, or `asking`.
  - `findings`: the number of findings of a `revise` report, only when there is at least one.
  - `note`: the run's `blocked` message, only with `outcome: "blocked"`.
- `stepsOf` sets them (`outcomeOf` in `modules/agent-graph/src/graph.ts`):
  - A `done` turn with a report: a review with verdict `approve` is `approved`, with verdict `revise` is `revise`;
    any other report is `reported`.
  - A `done` gate step is `passed`.
  - A `running` step of a run with `blocked` is `blocked`. Else a `running` turn with an open question is `asking`.
  - A `failed` or `waiting` step has no outcome. It keeps its `failed` or `not started` text.
- The step pod's meta line shows the outcome in place of the state text: `approved · sonnet 5.5`,
  `revise · 2 findings · sonnet 5.5`. A tone colors only the pod's ring, from theme colors: `--ok` for `approved`
  and `passed`, `--warn` for `revise` and `asking`, `--fail` for `blocked`. `reported` has no tone. A blocked step's
  hover title adds the blocked message.
- The Pipeline tab says "Approve" and "Revise" with the same tones. The graph does not import from the pipelines
  module; it uses its own words.

## Consequences

- The user sees each review's verdict and each stuck step on the graph, without opening the Pipeline tab.
- The pod's color still comes from its state. The tone is a ring on top, so a done step stays gray.
