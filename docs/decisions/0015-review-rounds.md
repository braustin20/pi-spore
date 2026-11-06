# 0015. Fixed review limits plus an early-stop Jev check

- Status: Accepted
- Date: 2026-11-06
- Requirements: R6.4

## Context

Fixed limits are predictable. Extra rounds on minor findings waste time.

## Decision

Hard limits: 2 review rounds, 1 adversarial fix pass. After each review round, Jev judges whether the remaining
findings justify another round. Jev can stop early. It can never add rounds.

## Consequences

- One small classifier call per round.
- Early stops are recorded with Jev's answer so the user can audit them.
