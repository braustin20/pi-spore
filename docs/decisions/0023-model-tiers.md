# 0023. Models are ranked by an editable tier list

- Status: Accepted; superseded in part by [0141](0141-router-ladders.md)
- Date: 2026-11-06
- Requirements: R4.4, R4.8

## Context

Upgrade approvals (ADR 0014) and the "reviewer must be stronger" rule (`min_strength_over`) need an order of
models. Price data does not work: subscription models through claude-bridge show a cost of $0.

## Decision

`~/.pi-spore/settings.json` holds a tier list, `local < light < medium < heavy`, and assigns each model to a tier.
The list is `"tiers": { "<provider>/<id>": "<tier>" }`; entries there are added to the built-in defaults. Defaults:
Strata = local; Haiku 5.5 and gpt-6-luna = light; Sonnet 5.5 and gpt-6.1-terra = medium; Opus 5.5 and gpt-6.1-sol =
heavy. Claude models are listed under `claude-bridge` and `anthropic`, OpenAI models under `openai` and
`openai-codex`. A model with no tier is an error at the point of use, not a guess. Within a tier, a change of provider
is not an upgrade.

## Consequences

- New models must be added to the list before a pipeline uses them.
- The router (`pi-extensions/router/`) owns the default list, because it runs in plain `pi` without the server. The
  server imports it from `@pi-spore/router`.
