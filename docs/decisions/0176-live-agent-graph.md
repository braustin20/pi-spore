# 0176. The workspaces landing page is a live graph of all agents

- Status: Accepted; extended by [0188](0188-agent-graph-step-outcome.md) (step outcome)
- Date: 2026-11-14
- Requirements: R3.3 (helpers), R6 (pipelines), R7 (runs and lanes), R15 (attention)

## Context

`/workspaces` with no workspace open shows the "Create a workspace" form. The user never uses it there. They want
that page to show every agent that works now, in every active workspace, as live trees: a run's coordinator with
its lanes, a workspace's chat with its pipeline runs, and each agent's running helpers. The look was approved in a
mockup (project artifacts `mockups/agent-graph/`).

No module gives that picture today. Home lists agents one row at a time. The parts that the graph needs are spread
over four modules (agents, pipelines, runs, workspaces), and some are not on their interfaces: an agent's child runs
and model, a workspace's pipeline runs, and a change hook for runs.

## Decision

### Page and module

- The workspaces landing page (`/workspaces` and `/workspaces/in/:projectId` with no workspace open) becomes the
  agent graph. The "Create a workspace" form moves to its own page, `/workspaces/new` (and
  `/workspaces/new/in/:projectId`). The "New workspace" button of the workspace list opens it.
- A new module `agent-graph` (`modules/agent-graph/`) owns the graph. It reads the other modules only through
  `host.use(key)`: `AgentsKey`, `PipelinesKey`, `RunsKey`, `WorkspacesKey`. Its web entry fills the landing page
  through a slot of the workspaces web interface, the same pattern as `setMain`.
- It owns one table later: the saved node positions (card 4). Nothing else is stored.
- The canvas uses `@xyflow/react` (React Flow), pinned at `12.12.1`. Custom nodes are React components, custom edges
  are SVG paths, and zoom, pan, and drag are built in. It is MIT and browser-only (zustand, classcat, d3 modules). Its
  peers allow React 19. It is added with the canvas, not before.

### What is in the graph

- Only workspaces in state `active`. A parked, archived, or deleted workspace and its agents are not in the graph.
  An archived workspace never comes back, and its saved positions are deleted with it.
- The planner workspace (ADR 0174) is not in the graph. Side chats and planner chats are not in the graph.
- A **run tree**: one per run workspace (`RunsKey.runOf`). The root is the run's coordinator chat. Each lane whose
  workspace is active and that has a pipeline run gives one group. A lane workspace has no tree of its own.
- A **workspace tree**: one per other active workspace with an active worker chat (not closed). The root is that
  chat. Each pipeline run of the workspace that is `running` or `waiting_user` gives one group, and so does the
  newest run when it has ended, so an idle workspace still shows how its last slice ended.
- Trees are sorted by workspace creation time, oldest first, so a new tree does not move the others.

### Shapes (`packages/shared/src/agent-graph.ts`)

- An **agent node**: agent id, workspace id, kind, role, title, status, `workingFor`, model (`provider/id`, the
  model the agent runs on, such as `spore/auto`), `routedModel` (the physical model of its newest answer, when it
  differs and is known), `since` (when it entered its status), and `helpers`.
- A **group**: pipeline run id, workspace id, lane id for a lane, name (the slice name, else the lane name, else the
  pipeline id), the run state, the current stage name, the current round, `live` (true while the state is
  `running`), and `steps`.
- A **step**: one node of a group, in pipeline order.
  - An agent stage that has started gives one step per turn: `task`, `review`, or `fix`, with its round and its
    stage agent node.
  - A gate stage gives one `gates` step with the gate names and no agent.
  - A stage that has not started gives one step with no agent.
  - Step state: `waiting` (not started), `running`, `done`, or `failed`. A turn with a report is `done`, a turn with
    an error is `failed`, the current turn is `running`. A gate step before the current stage is `done`; at the
    current stage it is `running`, or `failed` when the run failed or stopped there. A passed run has every step
    `done`.

### Helpers (subagents)

- Any agent node can have helpers: coordinator, worker chat, or stage agent.
- Source: the agent's child runs (ADR 0034), from the agents module. The `subagent-async` widget is parsed in one
  place, `modules/agents/src/child-runs.ts`. The graph never parses it again.
- `AgentsKey.liveState(agentId)` returns `{ model?, routedModel?, children }`: the agent's in-memory model, the
  physical model of its newest answer, and its child runs. The `routedModel` logic moves from the chat page to
  `packages/shared/src/chat.ts` so the page and the server use one function.
- A new `AgentChange` kind, `children`, fires when the child run list changes (a run, a step, a state, or a current
  tool), and when a process exit empties it. `helpers` still fires only when the running count changes, so Home does
  not rebuild for each tool call.
- A helper is a step in state `running` of a child run in state `running`. Its id is the run id, a colon, and the
  step index, so it stays the same across events. It carries the step's agent name, model, state, current tool, and
  `startedAt` when the snapshot has it. One stage agent can back several steps (a task turn and its fix turns, or a
  reused worker in two groups); its helpers show on its last node in the graph only, so each helper id appears
  once.
- When a helper stops qualifying, the next topic event still has it once, with its end state, so the canvas pops it
  in the right color: `failed` for a step or run that is `failed` or `rejected`, else `done` (also when its run is
  gone). The module then publishes one more event without it. `GET` and the snapshot for a new subscriber show only
  running helpers.
- Helpers are short-lived. They are not saved and have no saved position.
- Foreground helpers run inside the parent's process as its `subagent` tool call and are not in the snapshot
  (ADR 0034). They are not sub-nodes.

### API

- `GET /api/agent-graph` answers `{ trees }`.
- Topic `agent-graph:trees`, event `{ type: "graph", trees }`: the whole graph again, at most once per tick, after
  a change. A new subscriber gets the current graph first. The change sources are `AgentsKey.onChange` (with
  `children`), `AgentsKey.afterWorkerChange` (a workspace's first chat fires no `onChange`),
  `PipelinesKey.onChange`, a new `RunsKey.onChange`, and the workspace state change and delete hooks. A model
  change shows at the agent's next status change; it has no change kind of its own.
  Nothing polls.
- New interface methods for this: `AgentsKey.liveState`, `PipelinesKey.runsOf(workspaceId)` (the workspace's runs,
  newest first, as `GET /api/pipelines/workspaces/:id/runs`), and `RunsKey.onChange(listener)` (after each change
  that `runs:list` publishes).

## Consequences

- One module builds the picture. The canvas (card 3) only draws it, and the saved positions (card 4) live next to it.
- A whole graph per tick is simple and small at this scale (a few workspaces, tens of agents). If it grows, a diff
  event can come later.
- The graph shows a run's progress and helper ends that Home does not. Home stays the list of what needs the user.
- Three interfaces grow by one member each. Each is small and has one user now.
