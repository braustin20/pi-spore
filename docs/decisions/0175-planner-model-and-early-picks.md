# 0175. The planner falls back to the orchestrator model, and a pick before the first message is kept

- Status: Accepted; changes [0174](0174-project-planner-chat.md) and [0120](0120-orchestrator-chat-and-card-models.md) in part
- Date: 2026-11-11
- Requirements: R3.9

## Context

ADR 0174 starts a planner chat on `subagents.agentOverrides.planner`, else on Pi's default. Most users set an
`orchestrator` override and no `planner` one. Pi's default is often the router (`spore/auto`), so the planner chat
started on a model the user never chose for chats.

A model or thinking level picked in a chat goes to the running Pi process with `set_model` or
`set_thinking_level`. Pi writes a new session file only at its first assistant message. When the process stops
before that (the idle stop, or eviction for a free slot, ADR 0026), the next launch starts a new session on the role
default. The pick is lost, and the session shows no model change.

## Decision

- A planner chat's model and thinking are `agentOverrides.planner` when set, else `agentOverrides.orchestrator`,
  else Pi's default.
- When a chat has no session file yet, a model or thinking level picked in it is also saved on its chat row
  (`agents_agents.model`, the column a card's model uses, and `agents_agents.thinking`). The next launch of a new
  session passes them as `--provider`, `--model`, and `--thinking`. A pick in a chat that has a session file goes to
  Pi only: the resumed session keeps it. Stage chats still refuse a model change (`stage_model_fixed`).

## Consequences

- A planner chat runs on the same model as the orchestrator chat unless the user sets a planner override.
- ADR 0120 said `--thinking` always comes from the role default. A thinking level picked before the first message
  now comes first.
