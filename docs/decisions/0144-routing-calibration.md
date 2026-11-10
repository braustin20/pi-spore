# 0144. Calibrate the router's local choice from recorded outcomes

- Status: Accepted
- Date: 2026-11-08
- Requirements: R4.2, R4.3, R4.7, R18

## Context

ADR 0024 set the router's bars by hand (0.7, 0.55 under pressure) and said to retune them from recorded outcomes.
No outcome was recorded. In the user's `routing.jsonl`, 22 decisions gave 0 local runs: Jev's "straightforward"
answer has a median of 0.41, and the other three answers are usually near 1. Nobody can say if local work would have
been good enough. RouteLLM picks its bar from past tasks: the bar that sends a target share of them to the weak
model. That needs outcomes, and outcomes need some local runs.

## Decision

- **Outcome.** When a pipeline run ends, the `usage` module stores one row in its own table `usage_outcomes`: run,
  workspace, worker agent, run state, the verdict of the first reviewer stage (its last review, or none), review
  rounds, fix passes, and end time. It gets the run through `PipelinesKey.afterRunEnded`. It never reads the
  pipelines module's tables. Retention deletes outcomes with the same cutoff as `routing.jsonl` (ADR 0121).
- **Join.** The report joins an outcome to the worker agent's `initial` decision in `routing.jsonl` by agent id. The
  session escalated if an `escalation` record has the same session id.
- **Pass.** A local run passed when its reviewer stage ended with `approve` (fixes allowed) and its session did not
  escalate to the cloud model. Only `local` decisions with a verdict count toward a pass share.
- **Report.** `GET /api/usage/calibration`, the Usage page, and `pi-spore usage calibration` show:
  - for each Jev question, the answers in ten buckets (0 to 0.1, ..., 0.9 to 1), with the count, the local outcomes,
    and how many passed;
  - for bars 0.1 to 0.9, how many of the decisions Jev answered would have gone local (all four answers at or above
    the bar), and how many of those local outcomes passed;
  - the sample size next to every share, and "too little data" under 20 local outcomes;
  - a suggested bar: the lowest bar with at least 20 local outcomes and at least 90% passed. None otherwise.
- **Explore.** `router.explore` (0 to 1, default 0) is the chance that a task goes local when the
  "straightforward" answer is its only blocker. It applies only to a pipeline worker stage (`PI_SPORE_STAGE_ROLE`
  is `worker`), so a stronger reviewer checks the work (ADR 0009). A task over the local budget, a visual task, or a
  classifier error never goes local through explore. The decision record says `explore: true`.
- pi-spore never changes a bar by itself. The report only suggests one. The user sets `router.threshold` by hand in
  `settings.json`, or with the "Apply suggested bar" button on the Usage page after a confirm. The same page can turn
  `router.explore` off after a confirm; it cannot set explore to any other value.

## Consequences

- A small `explore` buys outcomes at the cost of some review rounds on local work.
- Plain chats on `spore/auto` have no outcome. They count as answers in the buckets, not in pass shares.
- The `usage` module now owns a table and requires `pipelines`.
- A pipeline worker's task prompt holds the brief's full text, not only its artifact path, so Jev scores the brief.
  Before this, Jev saw only a link to the brief and explore never fired for a pipeline worker.
- The suggestion is only as good as Jev's answers stay stable. A new Jev version may need a new sample.
