# 0034. pi-subagents helpers are child runs of their worker

- Status: Accepted
- Date: 2026-11-07
- Requirements: R3.3, R3.6, R3.9

## Context

A worker chat can start pi-subagents helpers. Today they are invisible: the UI shows nothing, and they do not count
against `agents.maxLive` (ADR 0026), although a background helper is its own runner process. Question Q5 asked how
to observe them. [Spike Q5](../spikes/q5-subagent-child-runs.md) answered it:

- `pi.events` stays inside the Pi process, so pi-spore cannot read it.
- Run files are in `<tmpdir>/pi-subagents-<scope>/`, not under `~/.pi/agent/pi-subagents/`, and they need a match
  from run to parent session.
- In RPC mode pi-subagents publishes its background runs as the widget `subagent-async` (a bounded JSON snapshot of
  the agent's own session), and answers `/subagents-inspect-rpc` with the widget `subagent-inspect`. pi-spore's
  Pi process already receives widgets.

## Decision

- **Source.** pi-spore reads the `subagent-async` widget of each agent process. It validates the payload with a
  TypeBox schema. A payload it does not understand is logged and shown as a chat notice once, and the child list
  stays as it was. It does not watch run files.
- **What is a child run.** A top-level run in the snapshot, with its steps. The page shows the label, each step's
  agent, model, and thinking level, the state, the current tool, and the time. Foreground helpers run inside the
  worker's process and are not in the snapshot. They stay visible as the worker's running `subagent` tool call.
- **Lifetime.** The list is the latest snapshot. A run leaves it when pi-subagents clears it (about 10 s after the
  run ends). When the agent process exits, the list is emptied.
- **Transcript.** `GET /api/agents/:id/children/:runId/transcript?child=` asks the agent's process for
  `/subagents-inspect-rpc` and returns the reply. It needs a run still in the list of a live agent process (404
  `child_not_found` otherwise). Ids in the request must match `[A-Za-z0-9:_.-]{1,200}`, because they go
  into a slash command.
- **Limits.** Each child run in state `running` counts as one live process against `agents.maxLive`, next to the
  agent processes. It blocks a new agent start (the agent waits for a slot, as in ADR 0026) but never stops a run
  that already exists. A queued run counts nothing. An agent with a running child run does not stop for idleness,
  because its process receives the helper's result.
- **Side chats.** They refuse helpers already: ADR 0033 gives them no subagent tools. The page shows no helper list
  for them. No code is added for this case.

## Consequences

- Background helpers show under their worker in the chat, with agent, model, and state, and can be read.
- Memory use is accounted: five busy agents and runners cannot exceed the limit by starting helpers. A worker can
  still start more helpers than the limit allows. pi-subagents has its own spawn caps for that.
- pi-spore depends on the snapshot format, `kind: "pi-subagents.async-status-snapshot"`, `version: 1`. A new
  version is rejected loudly, in one adapter (`modules/agents/src/child-runs.ts`).
- When the user stops an agent that has running helpers (the Stop button, parking, or archiving), the runner
  processes may keep running without a row in the UI. The Stop button is disabled while a child run is running.
  Parking and archiving still stop the process.
- Finished runs can be read only for a few seconds after they end. The result is also in the worker's chat as the
  helper's completion message.
