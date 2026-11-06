# 0017. One integration branch per run

- Status: Accepted
- Date: 2026-11-06
- Requirements: R7.4, R9.3

## Context

Lanes in a run depend on each other. Merging each to main leaves ordering and conflicts to the user.

## Decision

Each run has `run/<slug>-<id>`. Lanes branch from it and merge into it after their pipeline passes and the
coordinator approves. One PR goes from it to the base branch. A human merges. pi-spore never merges to the base
or enables auto-merge.

## Consequences

- One large PR per run to review.
