# 0016. Fail-first proof is a recorded artifact the reviewer checks

- Status: Accepted
- Date: 2026-11-06
- Requirements: R6.5

## Context

Re-running Unity batch-mode tests twice per change costs minutes and needs the editor closed.

## Decision

The worker saves the failing run of each new test as an artifact. The reviewer checks it. The gate stage re-runs
only the final passing suite.

## Consequences

- Proof quality depends on the reviewer. The reviewer prompt must require it.
