# 0152. A cloud reviewer may sit on the worker's own tier

- Status: Accepted; changes [0023](0023-model-tiers.md) and [0140](0140-pipeline-stage-agents.md) in part
- Date: 2026-11-08
- Requirements: R4.4

## Context

A router escalation (ADR 0141) moved a run's worker up to Sol. The default reviewer sits on that same heavy tier, so
`min_strength_over` (ADR 0023, 0140) refused to start the reviewer and the run blocked with "set a stronger model".
The rule asked for a strictly stronger model than the worker, and the ladder had just used the strongest tier the
user owns.

## Decision

`min_strength_over` compares the reviewer's tier with the tier of every model the worker used:

- A worker of any tier except `local`: a reviewer of an equal or higher tier may review it. The same model counts. A
  different model in the same tier counts.
- A worker of the `local` tier (Strata): a reviewer of a strictly higher tier still reviews it (R4.4). `local` on
  `local` is refused.
- A lower tier is always refused. A model with no tier is still a loud error at the point of use.

The check runs where it ran before: before the reviewer starts, and again on its report with the models it really
used. There is no new setting; the tier list is still the only input.

## Consequences

- The rule holds because a review runs in a fresh read-only chat (ADR 0140). An equal model re-reads the diff with no
  memory of the worker's reasoning, so it is still an independent check.
- An escalation to the top rung no longer blocks the run that needed it. A reviewer that is not stronger is no longer
  a reason to lower a rung.
- Local work keeps the strict rule, so the local model cannot review itself.
