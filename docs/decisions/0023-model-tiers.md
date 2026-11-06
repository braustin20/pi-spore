# 0023. Models are ranked by an editable tier list

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.4, R4.8

## Context

Upgrade approvals (ADR 0014) and the "reviewer must be stronger" rule (`min_strength_over`) need an order of
models. Price data does not work: subscription models through claude-bridge show a cost of $0.

## Decision

`~/.pi-spore/settings.json` holds a tier list, `local < light < medium < heavy`, and assigns each model to a tier.
Defaults: Strata and other local models = local, Haiku and Luna = light, Sonnet = medium, Opus and gpt-6.1-sol =
heavy. A model with no tier is an error at the point of use, not a guess. Within a tier, a change of provider is
not an upgrade.

## Consequences

- New models must be added to the list before a pipeline uses them.
