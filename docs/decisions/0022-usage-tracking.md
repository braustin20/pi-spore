# 0022. Track subscription usage and use it in routing

- Status: Accepted
- Date: 2026-11-06
- Requirements: R18, R4.9, R4.10

## Context

Workers that inherit the parent model (often Opus 5.5) spend Claude subscription usage on small tasks. Orca shows plan usage percentages for Claude and Codex. pi-claude-bridge already passes Claude's plan
windows to Pi extensions as `anthropic-ratelimit-unified-*` headers on `after_provider_response`.

## Decision

- A usage tap (shipped in the router extension) records the latest plan windows from any Pi process to
  `~/.pi-spore/usage/` and to the server.
- A `usage` module shows a Usage screen: plan windows with age, and token use per project, workspace, role, and
  model from session files.
- The router leans local when the Claude weekly window is above 75% or the 5-hour window is at 100%. It suggests,
  never forces, a switch for roles pinned to a cloud model.
- Default pipelines route the implement stage instead of using the parent model.

## Consequences

- Passive numbers go stale between requests. Stale numbers are shown as stale and are not used for routing.
- v1 is passive only. Use from Claude Code or the Codex CLI is not seen. Active polling of the plans' usage
  endpoints is a v2 option; those endpoints are not official APIs.
- Codex window data needs a source ([Q11]).
