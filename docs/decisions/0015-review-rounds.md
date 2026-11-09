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

## Note (2026-11-08)

The default `review` stage now has `fix_passes = 1`: a REVISE on round 2 gets one last fix with no review after it.
In real runs, round 2 ended in REVISE almost every time, and each one stopped the lane for a question. Rounds stay
hard: the fix pass adds no review. A stage without a fix pass still asks the user at its limit, now with three
choices: fix once, go on, or stop (ADR 0140).
