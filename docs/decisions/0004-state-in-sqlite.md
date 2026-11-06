# 0004. Workbench state in SQLite with durable jobs

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.6, R6.6, R7.6, R16.2, R16.3

## Context

ADR 0002 drops Pi Durable, so its documents and tasks are not available. Stages, deliveries, and PR watching must
survive restarts.

## Decision

One SQLite database through `node:sqlite` (built into Node, no native build, FTS5 available). A lock file stops a
second server. Each module owns its tables and migrations. Background work runs as jobs made of named steps; each
step commits its checkpoint with its effects in one transaction. Questions and answers to agents are delivery
rows. Mutating API calls take idempotency keys; spore-bridge tool calls carry receipt keys.

## Consequences

- One file to back up. Easy to inspect.
- We own the job runner. It must be small and well tested.
- Transcripts stay in Pi session files, not in SQLite. v2 search indexes them into FTS5.
