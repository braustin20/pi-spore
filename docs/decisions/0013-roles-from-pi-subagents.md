# 0013. Role defaults come from the pi-subagents setup

- Status: Accepted
- Date: 2026-11-06
- Requirements: R3.1, R3.2, R3.3

## Context

The user already tunes roles in `~/.pi/agent/settings.json` (`subagents.agentOverrides`) and agent files
(`~/.pi/agent/agents/`, pi-subagents built-ins): worker on Sonnet, reviewer on gpt-6.1-sol, scout on Haiku, and a
local worker.

## Decision

pi-spore reads role defaults (model, thinking, prompt) from that setup and layers project, run, and workspace
overrides on top. Workers may still call pi-subagents for helpers; the UI shows them as child runs.

## Consequences

- One place to change a role's model for both `pi` and pi-spore.
- pi-spore depends on the pi-subagents settings format. A format change must be handled in one adapter.
- ADR 0034 settles how child runs are observed.
- ADR 0120: the workspace chat reads the `orchestrator` role, not `worker`. `worker` is a subagent role that the
  user may set to `spore/auto`.
