# 0010. Local models run one job at a time; others wait

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.5, R4.6

## Context

Strata serves one model on one GPU. Two sessions interleaving requests would each force a reload of up to 128k
tokens of prompt cache.

## Decision

Each local target has a concurrency setting (Strata: 1). In pi-spore, a session routed to a local target holds a
slot from the server until its stage ends. Others wait, and the UI shows "waiting for Strata". In plain `pi`, a
lock file does the same. A second local server is added as another target in settings.

## Consequences

- Local lanes run one after another. Throughput is lower but cost is zero.
- Strata start and stop stay with `strata-model.ts`.
