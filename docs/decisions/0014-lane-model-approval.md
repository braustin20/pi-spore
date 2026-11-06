# 0014. Lane models auto-approve unless the coordinator upgrades

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.8, R3.4

## Context

Approving every lane's model is busywork when lanes use role defaults. Upgrades cost money or time.

## Decision

Lanes on role defaults or the router start at once. If the coordinator asks for a model that is in a higher tier than the role default (ADR 0023), pi-spore creates an Approval on Home and the lane waits.

## Consequences

- Uses the tier list from ADR 0023.
