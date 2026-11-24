# 0194. The planner and the coordinator start read-only helpers with `start_helper`

- Status: Accepted; changes [0174](0174-project-planner-chat.md) in part
- Renumbered from 0176 on 2026-11-23; old commits cite the old number.
- Date: 2026-11-14
- Requirements: R3.3, R3.6, R3.9, R7.1

## Context

Orchestrator chats start `scout` and `researcher` through the pi-subagents `subagent` tool, always in the
background (`pi-extensions/spore-bridge/src/rules.ts`). The planner chat (ADR 0174, `PLANNER_CHAT_TOOLS`) and the run
coordinator (ADR 0150, `COORDINATOR_TOOLS`) cannot. Their tools are a `--tools` allowlist by name, and `subagent`
is left out, because it can start any agent, a writing `worker` too. The user wants these chats to get helpers.

[The spike](../spikes/readonly-helpers.md) found:

- pi-subagents has a **capability ceiling** (`pi-subagents/capability-ceiling`), registered per session by an
  extension in the parent process. Its `allowedAgents` refused a `worker`, alone and as a workflow child. Its
  `allowedTools` cuts the helpers' own tools.
- The helpers are not read-only by themselves. The built-in `scout` has `bash` and `write`. Without a tool ceiling,
  a scout started from a read-only chat created two files in that chat's folder.
- The raw `subagent` tool has write paths that a ceiling does not cover: agent `create`, `update`, and `delete`,
  `output` paths, `worktree: true`, schedules, and missions.
- pi-subagents' in-process event-bus RPC has a `spawn` method. It is async-only and uses the same executor as the
  tool, so ceilings, `PI_SUBAGENT_MAX_DEPTH`, and spawn caps apply. A throwaway `start_helper` tool built on it
  started a scout. Its result came back as a `subagent-notify` message that started a turn on its own. The run
  showed in the `subagent-async` widget that ADR 0034 reads.
- pi-subagents has no per-session setting to force `async: true`. `forceTopLevelAsync` is global.

## Decision

- **Tool.** spore-bridge registers one tool, `start_helper`, in the planner chat (`PI_SPORE_CHAT_KIND=planner`)
  and in the coordinator (`PI_SPORE_RUN_ROLE=coordinator`), and nowhere else. `PLANNER_CHAT_TOOLS` and
  `COORDINATOR_TOOLS` add `start_helper`. Neither list gets `subagent`.
- **Parameters.** `{ agent: "scout" | "researcher", task: string }`, a TypeBox schema. Nothing else: no model, cwd,
  output, worktree, context, or async field.
- **Launch.** The tool sends the pi-subagents RPC request `spawn` with
  `{ agent, task, context: "fresh", cwd: ctx.cwd }` on `subagents:rpc:v1:request` and waits for its reply on
  `subagents:rpc:v1:reply:<requestId>`. `spawn` only starts background runs, so every helper runs in the
  background. The model never sees the raw `subagent` tool.
- **Result.** On success the tool answers with its own text, not pi-subagents' text (that names
  `subagent({ action: "status" })`, a tool these chats lack):
  `Started <agent> in the background (run <runId>). Its result comes back to this chat as a message. Do not poll
  for it.` The result arrives as pi-subagents' completion message, which starts a turn when the chat is idle.
- **Ceiling.** At `session_start`, spore-bridge registers a capability ceiling for the session id with source
  `pi-spore`: `allowedAgents: ["scout", "researcher"]` and
  `allowedTools: ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content",
  "source_check"]`. It disposes the ceiling at `session_shutdown`. The tool list is the gate for the chat; the
  ceiling is the gate for its helpers and their children. `denyExtensions` stays off, because the researcher's web
  tools come from an extension. spore-bridge imports the public `pi-subagents/capability-ceiling` export from an
  exact-version `pi-subagents` dependency. The registry is a `globalThis` symbol, so this copy meets the copy the
  user's Pi loads.
- **Errors.** Each one fails the tool call with a message:
  - Another agent name: Pi's argument check refuses it before the tool runs, and names the allowed agents:
    `agent: expected one of ["scout","researcher"]`. If an agent gets past it, the ceiling refuses it with
    `... does not allow agent '<name>'. Allowed agents: researcher, scout.`
  - pi-subagents not loaded (no `subagents:rpc:v1:ready` event): `start_helper needs the pi-subagents Pi package,
    and it is not loaded in this chat.`
  - No reply within 10 s: `pi-subagents did not answer the spawn request in 10 s.`
  - A refused spawn: the reply's error code and message, unchanged. For example the depth limit:
    `Nested subagent call blocked (depth=0, max=0) ...`.
- **Rules.** `PLANNER_RULES` and `COORDINATOR_RULES` get these lines. The planner's "You cannot ... start agents"
  becomes "You cannot change files, run commands, or start work".

  ```
  - Start helpers with start_helper before you read deeply. Use `scout` for big questions about this repository:
    where a thing lives, how a part works, what calls what. Use `researcher` for facts from outside: library docs,
    versions, APIs. Give each one a clear question and the paths to start from.
  - Helpers only read. They cannot change files or run commands. Each result comes back to this chat as a message.
    Do not poll for it. Start another round only if the first is not enough.
  ```

- **Limits.** No new limit. A running helper counts as one live process against `agents.maxLive`, and keeps the
  chat from stopping for idleness, through the widget (ADR 0034). `agents.maxSubagentDepth` reaches the chat as
  `PI_SUBAGENT_MAX_DEPTH` (ADR 0168); `0` refuses every helper. pi-subagents' own spawn caps apply.
- **Read-only stays.** ADR 0174 and ADR 0150 stay as they are: neither chat has a tool that writes files or runs
  commands, and neither gets `subagent`. This ADR replaces only ADR 0174's line "The planner reads the code itself"
  and its consequence "The planner cannot run ... scouts".

## Consequences

- The planner and the coordinator can ask scouts and researchers, on the models the user set in Pi
  (`subagents.agentOverrides`). pi-spore does not change those models.
- Their helpers are weaker than an orchestrator's: a scout has no `bash`, so no `git log` or `rg`. Read tools are
  enough for "where" and "how" questions.
- Helpers show in the chat's helper list with agent, model, and state. No pi-spore code changes for that, because
  the manager reads the widget of every agent process.
- When the user closes a planner chat while a helper runs, the helper finishes and its result reaches no chat
  (ADR 0034: the runner outlives the agent process).
- pi-spore depends on three pi-subagents contracts: RPC `version: 1`, the ceiling registry
  `pi-subagents.capability-ceiling.v1`, and the async snapshot `version: 1`. A missing RPC fails the tool loudly. A
  pi-subagents that stops reading the v1 ceiling would let a helper keep `bash` and `write`, and pi-spore cannot see
  that at run time. So the dependency is pinned, and an upgrade of it reruns the spike's two refusal checks (a
  `worker` name, and a scout told to write a file).
- Tests cannot run pi-subagents (AGENTS.md). Card 2 tests the tool's schema, the spawn request it sends, its
  answers to each reply, and the ceiling it registers, with a fake event bus.
- `docs/architecture.md` changes with the code in card 2.
