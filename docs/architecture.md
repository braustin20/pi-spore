# pi-spore: Architecture

This document describes how pi-spore meets [vision.md](vision.md). Decisions live in [decisions/](decisions/).
Open questions are marked **[Q]** and collected in [open-questions.md](open-questions.md).

## 1. Overview

```text
 Browser (React + Vite)              pi-spore CLI
        │  HTTP + WebSocket                │  HTTP
        └──────────────┬───────────────────┘
                       ▼
 ┌──────────────────── pi-spore server (Node, Hono + ws) ─────────────────────┐
 │ core: module registry · settings · SQLite store · job runner · event bus   │
 │ modules: projects · vcs-git · vcs-folder · workspaces · agents · chat ·    │
 │   pipelines · runs · changes · github-pr · kanban · attention · actions ·  │
 │   terminals · artifacts · routing · usage · unity                          │
 └───────┬───────────────────────┬──────────────────────┬─────────────────────┘
         │ RPC over stdio        │ git / gh / unity     │ node-pty
         ▼                       ▼ (no shell)           ▼
  pi --mode rpc  (one process    git worktrees,        terminals in
  per agent; loads your normal   GitHub, Unity         workspace dirs
  Pi settings, packages, skills, editors and batch
  MCP, plus the spore-bridge     mode
  extension)
         │ HTTP to server (spore-bridge tools: ask, report, cards, actions)
         └──────────────► pi-spore server
```

## 2. Agent runtime

See [ADR 0002](decisions/0002-agent-runtime-pi-rpc.md).

- Each agent is one `pi --mode rpc` child process, driven by pi-spore's own small RPC client
  (`modules/agents/src/rpc.ts`). Pi's `RpcClient` cannot answer extension dialogs and hides the process, so it is
  not used. The process loads the user's normal Pi setup through `--no-extensions`, `--no-skills`, and
  `--no-prompt-templates` plus one explicit flag per resource, as resolved by Pi's `DefaultPackageManager`
  (ADR 0025).
- One process per agent keeps the behavior of the `pi` CLI exactly. Extensions that keep per-process state still
  work. Examples: the Strata pid leases in `strata-model.ts`, and `process.env` changes. One crashing extension
  takes down one agent, not the server.
- Launch arguments: `--session <path>` (or `--session-dir` for a new one, or `--fork <worker session> --session-dir`
  for the first start of a side chat with the worker's context), `--model`, `--thinking`, `--tools` and
  `--exclude-tools` for side chats (below), `--no-extensions` plus one `-e` per extension from the user's setup minus
  `agents.excludeExtensions` (ADR 0025), `-e <repo>/pi-extensions/router` (section 10; skipped when the user's setup
  already loads it), and `-e <repo>/pi-extensions/spore-bridge` (the same way). After the user's skills comes
  `--skill <repo>/pi-skills/project-wiki` (`SPORE_SKILLS`, ADR 0193; skipped the same way). The cwd is the
  workspace directory. pi-spore's rules come from spore-bridge, not from a prompt file (ADR 0031).
- Env given to each agent (the server's env minus `ORCA_*` and `HERDR_*`): `PI_SPORE_URL`, `PI_SPORE_TOKEN` (this
  process's agent token, ADR 0032), `PI_SPORE_SERVER_PID` (the server's pid, for the bash guard, ADR 0160), `PI_SPORE_AGENT_ID`, `PI_SPORE_WORKSPACE_ID`, `PI_SPORE_CHAT_KIND` (`worker`,
  `side`, `planner`, or `stage`), `PI_SPORE_UNITY_PROJECT` (Unity projects), and from launch hooks `PI_SPORE_RUN_ID` and `PI_SPORE_RUN_ROLE`
  (`coordinator` or `lane`, section 9). Later: the workspace action env.
- **Context meter.** The chat header's "context N%" is `contextUsage` from Pi's `get_session_stats`. The manager
  reads it when the process starts, after each `turn_end` (one model response and its tool calls), on
  `agent_settled`, and after a compaction. So a long single run, such as a pipeline worker's, shows it grow. A
  `turn_end` read is skipped while the last one has no answer yet. A failed read changes nothing. On `spore/auto`
  there is no usage until the first response, because Pi takes the window from the model that answered.
- **Launch hooks** (ADR 0150). `AgentsKey.addLaunchContext(hook)` registers a synchronous hook that the manager calls
  at each launch with the agent and its workspace. It may add `env` and replace the tool allowlist with `tools`
  (`--tools <tools> --exclude-tools mcp__*`). Two hooks that give `tools` for one agent fail the launch. A hook never
  changes the bridge token's read-only flag.
- **Prompt hooks** (R8.3). `AgentsKey.addPromptHook(hook)` registers a synchronous hook that `POST /api/agents/:id/prompt`
  calls for each prompt, inside one transaction. A hook returns text to add to the message and marks what
  it took in that transaction. If any hook returns text, the route queues the whole message, with its images and
  steer choice, as one delivery and answers `queued`. A prompt also goes into the queue when the chat already has
  a pending delivery, so a later message never overtakes an earlier one. This holds for every chat, with or without comments: a delivery
  that cannot be sent (Pi fails to start, for example) holds later messages behind it until it goes out. A message that
  starts with `/` is a slash command: hooks skip it, so staged comments stay for the next message. The `changes` module uses it for staged diff comments (section 11d).
- **Chats** (ADR 0030, ADR 0033, ADR 0120). The role of a workspace chat is `orchestrator`: a new chat starts on
  `subagents.agentOverrides.orchestrator` (model, thinking) from Pi's settings, and on Pi's own default when that
  override is missing. The `worker` role is a subagent on `spore/auto`; `worker` stays only as a chat `kind`, in
  `PI_SPORE_CHAT_KIND`, and in the routes. An agent is one chat: one row in `agents_agents` with a `kind` (`worker`,
  `side`, or `stage`), an `active` flag, a `title`, `forked_from` (the orchestrator chat a side chat copies), and a nullable
  `model` (`provider/id`).
  - The model of a new chat (ADR 0120): `AgentsKey.activeWorker(workspaceId, { model? })`, `POST /api/agents`, and an
    orchestrator chat from `POST /api/agents/chats` take an optional `model`, stored in `agents_agents.model`. On the
    first start, `--provider` and `--model` come from it, else from `agentOverrides.orchestrator`; `--thinking`
    comes from `agents_agents.thinking`, else the role default. A model or thinking level picked in a chat that has
    no session file yet is saved in these columns too, so a process that stops before the first message keeps the
    pick (ADR 0175). A resumed session keeps its own model. An existing chat keeps its model, so
    `activeWorker` ignores `model` when the workspace already has one.
  - Tools (ADR 0189): an orchestrator chat has Pi's normal tools less pi-subagents' loader
    (`--exclude-tools subagents_enable`, `WORKSPACE_CHAT_TOOLS`), so `subagent` is active from its first request. On a
    bridge model the loader would turn `subagent` on only at the next typed prompt, and a Home answer is not one.
  - A workspace has one active orchestrator chat (a partial unique index). Only it and side chats can run; an older orchestrator
    chat is read-only history and refuses to start with 409 `chat_inactive`. The manager also refuses to start an
    orchestrator chat while another orchestrator chat of the workspace has a live process (409 `worker_running`).
  - New chat: the active orchestrator chat becomes inactive, its process stops (its session file stays), and a new active
    orchestrator chat starts empty. Make active works the same way for an older chat. Both refuse with 409 `worker_busy`
    while the current orchestrator chat is busy, starting, or waiting for a slot. Chat changes of one workspace run one at
    a time.
  - Close (ADR 0110): the "x" on a chat tab sets `closed = 1`, `active = 0`, and `closed_at`, and stops the process.
    The row and session file stay until retention deletes them (section 14, ADR 0121). A closed chat is left out of the chat list, the
    `agents:list` snapshot, and Home; a `removed` event drops it from open pages. It cannot be activated again
    (409 `chat_closed`). A chat that is working refuses with 409 `chat_busy`. Closing the active orchestrator chat leaves
    the workspace without one, and the next `POST /api/agents` starts a fresh chat. In an archived workspace it
    answers 409 `workspace_archived` instead, so no new chat races retention.
  - A chat that becomes inactive drops its Home items: its failure, its finished mark, and its open questions, which
    are closed (ADR 0033). Pending deliveries to it wait until it is active again.
  - Side chats: any number, next to the worker, counted against `agents.maxLive` like any agent. They start empty,
    or with `--fork` from a copy of the active orchestrator chat's session on their first start (409 `nothing_to_fork`
    when the orchestrator chat has no session yet). The copy keeps the worker's model. After that first start the page
    gets a new snapshot with the copied messages.
  - Side chats are read-only through their tools: `--tools
    read,grep,find,ls,request_human_input,artifacts_list,artifacts_read` and `--exclude-tools 'mcp__*'` (ADR 0033,
    ADR 0070). Their bridge token is read-only, so bridge routes that run commands refuse
    it, and spore-bridge gives them their own rules.
  - Planner chats (ADR 0174): each project has one planner workspace (`workspaces_workspaces.planner = 1`, in place
    on the main checkout, name "Plan"), found or made by `POST /api/workspaces/planner { projectId }`. Its chats are
    worker-kind chats with role `planner`: they start on `subagents.agentOverrides.planner`, else
    `agentOverrides.orchestrator` (ADR 0175), launch with
    `PLANNER_CHAT_TOOLS` (the side chat tools plus `kanban_list_cards`, `kanban_read_card`, `kanban_add_card`,
    `kanban_update_card`, `web_search`, `fetch_content`, `get_search_content`, `start_helper` (ADR 0194); no
    `subagent`; `--exclude-tools 'mcp__*'`), a read-only
    token, and `PI_SPORE_CHAT_KIND=planner`. A launch hook that gives one tools fails the launch. Side chats in it answer 409
    `planner_no_side_chats`. The bridge lets a planner token add and edit cards, and move them only between
    `backlog` and `ready`. Rename, park, resume, and archive of the planner workspace answer 409
    `planner_workspace`; it does not block removing the project. The web shows it as a "Plan" row first under each
    project, opens it as a chat-only page (no Details column), and leaves it out of the kanban pickers.
  - Title: the first user message, cut to 60 characters, set on the first prompt. Chats from before titles take it
    from their history when first read; side chats never take it from the copied history. The user can rename.
  - Chat bar: the tab of a working chat (busy, starting, or waiting) shows a pulsing dot that screen readers read as
    "working", and the selected tab scrolls into view when the selection changes. The chat pane keeps its tabs in step
    with `agents:list` after its first load: live statuses, new chats of the workspace (such as a stage agent that a
    pipeline or Retry starts), and closed chats. It sorts them with `orderChats`, the server's order. One "+" button after the tabs ("New chat or side
    chat") opens a `Menu` with New chat, Side chat, and Side chat with context, each with a one-line hint. It is
    disabled while the workspace is not active. The rename pencil follows it. `NEW_CHATS` in
    `modules/agents/src/chats.tsx` lists these items for this menu and for the phone row's "Chat actions" menu.
- **Stage agents** (R6, [ADR 0140](decisions/0140-pipeline-stage-agents.md)). A pipeline runs each stage on its own
  agent: kind `stage`, with a role (`worker`, `reviewer`, or `adversarial-reviewer`), a title (`implement`,
  `Review 1`, ...; `<slice name> - implement` when the run has a name), and a fixed model. They show as chat tabs
  after side chats. A busy, starting, or waiting stage agent sets the workspace's status line (section 13).
  - `AgentsKey.createStage(workspaceId, { role, title, model? })` inserts the row and starts nothing, so the
    pipelines module commits it with the `deliver` that starts it. `roleDefaults(role)` reads
    `subagents.agentOverrides.<role>`, with `planner` and `coordinator` falling back to `orchestrator` when they
    have no entry (ADR 0175, ADR 0181); `availableModels(callerAgentId?)` lists the models Pi can run (a busy
    caller's own process answers, so it does not wait for a slot it holds); `modelsUsed(agentId)` lists the physical
    models Pi recorded on the agent's assistant messages; `sessionRoles(workspaceId)` lists the session file and role of each agent that has a session,
    so the `usage` module can split token use per role.
  - The thinking level comes from the role default. Env adds `PI_SPORE_CHAT_KIND=stage` and `PI_SPORE_STAGE_ROLE`.
  - Reviewer roles are read-only like side chats: `--tools read,grep,find,ls,artifacts_list,artifacts_read,report,
    ask_coordinator,ask_orchestrator` (spore-bridge registers `ask_coordinator` only in a lane and
    `ask_orchestrator` only outside one), `--exclude-tools 'mcp__*'`, and a read-only token. A stage `worker` has
    Pi's normal tools less `contact_supervisor` (`--exclude-tools contact_supervisor`): that pi-subagents tool works
    only in a child pi-subagents started, so it always fails in a stage agent (ADR 0179).
  - The model cannot change (`POST /api/agents/:id/model` answers 409 `stage_model_fixed`; the chat has no model
    picker and shows the model read-only, with the routed model after `→`), because the pipeline judges a reviewer
    by the model it ran on (R4.4). A stage whose agent failed continues on Retry, or gets a fresh agent on Fresh
    agent (section 8, "Failed turns").
  - `turnError(agentId)` says why the agent's last run failed, as `{ error, provider? }`: the error of a `failed`
    status, or the `errorMessage` of the last assistant message when Pi ended the turn with `stopReason: "error"` (a
    provider that refused, such as a full usage window), with that message's `provider`. While the agent is not busy,
    starting, or waiting, it first returns the error of a pending delivery Pi refused (section 6). It is undefined
    while a delivery waits with no error or a prompt Pi took has not started: a new run is on its way (ADR 0198). `rename(agentId, title)` sets the title.
  - `endedRun(agentId)` says the agent's last run ended on its own and nothing new waits for it: the agent is
    `idle`, it has no pending delivery, and its last assistant message did not end with `stopReason` "error" or
    "aborted". A pending delivery counts because a process goes idle once at start-up, before Pi takes its prompt.
    A prompt Pi took but has not started yet counts as not ended too.
- Transcripts are Pi session JSONL files in `~/.pi-spore/sessions/<workspace id>/`. They can still be opened in the
  CLI with `pi --session <path>`.
- Extension dialogs (`extension_ui_request`) become pending prompts on the chat and on Home. The answer goes back as
  `extension_ui_response`. Dialogs with a timeout resolve on their own as Pi defines.
- **spore-bridge** (`pi-extensions/spore-bridge/`, package `@pi-spore/spore-bridge`) is a Pi extension that adds
  the workbench tools. It calls the `bridge` module's routes (`/api/bridge/`) with `PI_SPORE_URL` and the agent
  token (ADR 0032). A failed call reaches the model as a tool error that quotes the server.
  - `request_human_input` `{ question, choices?, recommended? }` or `{ steps }`, each with optional `artifacts`
    (section 11b): files a question for the user (Home) and ends the turn with `terminate: true`. Its guidelines and the rules say to ask related
    decisions in one call with steps. The answer arrives later as a new user message, through a delivery (section 6), so
    a long wait survives restarts. Its guidelines say to use the user's `ask_user` only for a quick choice while the user watches.
  - `check`: runs the project's `check` action and returns its outcome and log tail (ADR 0025).
  - `run_action` `{ name, background? }`: runs a named project action the same way.
  - Both start the run, follow it with `GET /api/bridge/runs/:id?wait=25000` until it ends, then read the last
    16 KiB of its log. An aborted tool call cancels the run.
  - With `background: true`, `run_action` returns at once with the run id and log path (ADR 0160).
    `stop_action` `{ runId }` cancels a run of the workspace through `POST /api/bridge/runs/:id/cancel`, with the
    tool call id as receipt. The cancel route refuses read-only chats, like the start route.
  - The bash guard (ADR 0160): a `tool_call` handler blocks a `bash` command that would stop the pi-spore server. It
    reads the command text: `kill` of the server's pid, `-<pgid>`, `-1`, or `$PI_SPORE_SERVER_PID`; `kill` fed by
    `$(...)` or `xargs` from a command that names the server's port; `pkill` and `killall` patterns that match the
    server's name or command line (read once with `ps`) or name `node`, `dist/main.js`, `pi-spore`, or
    `packages/server`; `fuser -k` on the port. Other commands run. A script or `bash -c` can still get past it.
  - Card tools (ADR 0100), limited to cards of the agent's project: `kanban_list_cards` `{ label?, column? }` (also
    lists the project's active workspaces, without bodies), `kanban_read_card` `{ cardId }` (the card's line and its
    full notes), `kanban_add_card` and `kanban_update_card` (title, body, column, labels, due day, `blockedBy` card
    ids, `model`), and `kanban_start_card` `{ cardId, reason, workspaceId? | isolation?, line?, base? | run?,
    base? }`. The start tool files a `card-start` approval on Home and ends the turn with `terminate: true`; the
    decision comes back as a new user message. Without `workspaceId` the target is a new workspace with isolation
    `new` unless another is given; `run: true` asks for a new run. A run's coordinator gets the list, read, and add
    tools (ADR 0154); see section 9.
  - `open_pr` `{ title, body }`, only in the orchestrator chat (not side, stage, coordinator, or lane agents; ADR
    0163): files a `workspace-pr` approval through `POST /api/bridge/workspace/pr` and ends the turn with
    `terminate: true`. The tool call id is the receipt (R16.3). The rules say to call it when card work passes check
    and the tests, and to report `not_supported` without a retry.
  - `push_line` `{}`, only in the orchestrator chat (ADR 0164): pushes the workspace's branch through
    `POST /api/bridge/workspace/push`, so the chat can push fixes for a PR that pi-spore merges when checks pass.
  - Artifact tools (ADR 0070), limited to the agent's workspace and its project: `artifacts_list` (both scopes),
    `artifacts_read` `{ scope, path }` (text only; other bytes answer 415 `not_text`), and `artifacts_write`
    `{ scope, path, content }`, which replaces a file at that path. The bridge takes the folder from the token,
    never from the request. A read-only side chat or planner chat may list and read; a write answers 403
    `read_only_chat`.
  - Every run of the agent replaces the global `AGENTS.md` in the prompt with pi-spore's rules (ADR 0031). Side
    chats (`PI_SPORE_CHAT_KIND=side`) get side chat rules instead (ADR 0033), and planner chats
    (`PI_SPORE_CHAT_KIND=planner`) get planner rules (ADR 0174). Stage agents get stage worker or stage
    reviewer rules: end every turn with `report`, and record fail-first proofs (ADR 0199: a failing run before the
    code, or with the code broken on purpose and restored). The reviewers check that the brief's tests are there and
    that each proof fails for the right reason. The stage worker runs `check`, then
    the full `run_action test`, before every `report`, and puts both results in it, so a break shows up before the
    reviewers, not at the final gates. The orchestrator rules say to start
    every subagent with `async: true`, because a foreground child does not load the chat's extensions (ADR 0120),
    and to send each slice of feature code through the workspace pipeline, not a `worker` subagent (ADR 0162). The
    orchestrator and coordinator rules name the tests to add in each brief and check them when the work comes back
    (ADR 0199).
    Every role's rules end with one docs paragraph (`DOCS_RULES`, ADR 0193): start with `docs/index.md` when the
    project has one, update it in the same change as the docs, and use the project-wiki skill for the format, the
    setup, and the lint.
  - `start_pipeline` `{ brief, pipeline?, name? }`, only in the orchestrator chat (`worker` kind, no run role; ADR 0162):
    posts `POST /api/bridge/pipelines` with the tool call id as receipt and ends the turn with `terminate: true`.
    The run's end arrives later as a message (section 8). `start_pipeline`, `start_lane`, and `revise_lane` read a
    brief artifact, so they are registered with `executionMode: "sequential"`. Pi then runs every tool call of that
    assistant message one by one, in order, so an `artifacts_write` of the brief earlier in the same message is done
    first. The rules also say to call them in the next step after the write's result, in the same turn, and never
    to end a turn to wait for the user without `request_human_input`.
  - Stage questions (ADR 0179). A stage agent outside a lane gets `ask_orchestrator` `{ question }` in place of
    `request_human_input`. It posts `POST /api/bridge/stage-questions` with the tool call id as receipt and ends the
    turn with `terminate: true`. The orchestrator chat (the chats that get `start_pipeline`) gets `answer_stage`
    `{ questionId, answer }`, which posts `POST /api/bridge/stage-answers`. Both stage rule sets say: when the brief
    leaves a decision open, ask with `ask_orchestrator` (in a lane: `ask_coordinator`); never use
    `contact_supervisor`; do not guess. Section 8 has the server side.
  - `report` `{ turn, summary, verdict?, findings?, tests? }`, only in stage agents (R6.7): ends a pipeline turn with
    `terminate: true` through `POST /api/bridge/reports` (open to read-only reviewers). Reviewers give a verdict
    (`approve`, `revise`) and findings (`blocking`, `important`, `minor`); the worker lists each new test with the
    artifact path of its failing run. For a reviewer's REVISE with findings but none blocking, the tool first asks
    the Jev classifier (`router.classifier`, through `ctx.modelRegistry.classify`) whether another round is worth
    it, and adds `earlyStop: { stop, probability }` (stop at P >= 0.7), or `{ stop: false, error }` when the
    classifier fails (ADR 0140).
  - Run tools (R7, ADR 0150), by `PI_SPORE_RUN_ROLE`. The coordinator gets `start_lane` `{ name, brief, wave,
    dependsOn?, pipeline?, model? }`, `revise_lane` `{ laneId, brief, model? }`, `merge_lane` `{ laneId }`, and
    `answer_lane` `{ questionId, answer }`, and coordinator rules in place of the orchestrator rules. Of the card
    tools it gets only `kanban_list_cards`, `kanban_read_card`, and `kanban_add_card` (ADR 0154). A lane agent
    gets `ask_coordinator` `{ question }` in place of `request_human_input`; it files the question and ends the turn
    with `terminate: true`. Lane agents get one more paragraph of rules: ask the coordinator, never the user.
  - `start_helper` `{ agent: "scout" | "researcher", task }`, only in the planner chat and the coordinator
    (`pi-extensions/spore-bridge/src/helpers.ts`, ADR 0194). These chats have no `subagent` tool, which could start a
    writing `worker`. The tool sends the pi-subagents event-bus RPC request `spawn`
    `{ agent, task, context: "fresh", cwd }` on `subagents:rpc:v1:request` and waits up to 10 s for
    `subagents:rpc:v1:reply:<requestId>`. `spawn` starts only background runs. It answers
    `Started <agent> in the background (run <runId>) ...`; the result comes later as pi-subagents' completion
    message. It fails loudly when pi-subagents is not loaded (no `subagents:rpc:v1:ready`), on no reply, and on a
    refused spawn (the reply's code and message). At `session_start` the same two chats register a pi-subagents
    capability ceiling for the session id, source `pi-spore`: `allowedAgents` scout and researcher, `allowedTools`
    `read,grep,find,ls,web_search,fetch_content,get_search_content,source_check`. It is disposed at
    `session_shutdown`. So the helpers and their children cannot write or run commands. spore-bridge pins
    `pi-subagents` at `0.86.0`; an upgrade reruns the spike's two refusal checks
    ([spike](spikes/readonly-helpers.md)). Their rules say to start helpers before deep reading and not to poll.
- A process is started when an agent has work and stopped when it is idle for a while or its workspace is parked.
  Restarting it with `--session` restores the conversation.
- Spike Q1 ([notes](spikes/q1-rpc-agents.md)) confirmed the full setup loads in RPC mode. Rules from it:
  - Agent env drops `ORCA_*` and `HERDR_*`, so agents do not report into the terminal that started pi-spore.
  - Pi hangs when a session's stored working folder is gone. Before `--session`, pi-spore checks that folder.
    Archived transcripts are read from the session file directly, without starting Pi.
  - Every agent start has a timeout. On timeout, pi-spore stops the process and shows its stderr.
  - Agents run without pi-lens and get a `check` tool instead (ADR 0025).
- Limits: at most 8 live agent processes; an idle agent process stops after 10 minutes, or at once when a chat
  waits for a slot, longest idle first (ADR 0026). Running background helpers count as live processes in the 8
  (ADR 0034).
- **Helpers** (child runs, R3.3, ADR 0034, [spike Q5](spikes/q5-subagent-child-runs.md)). A worker's pi-subagents
  helpers show under it in the chat. So do the scouts and researchers that a planner chat or a coordinator starts
  with `start_helper` (ADR 0194), from the same widget.
  - Source: the `subagent-async` widget that pi-subagents sets in RPC mode, a `PI_SUBAGENT_ASYNC_JSON:` line with a
    version 1 snapshot of the agent's own session. `modules/agents/src/child-runs.ts` validates it (the one place
    that knows its format). A payload it does not understand is logged, shown as one chat notice, and the list stays
    as it was. Run files and `pi.events` are not used.
  - A child run is a top-level run of the snapshot with its steps: label, state, current tool, and per step the
    agent, model, and thinking level. Only a change of these is published, as `{ type: "children", children }` on
    the `agent:<id>` topic; the snapshot event carries the list too. The list empties when the process exits.
    Foreground helpers run inside the worker's process and stay the worker's running `subagent` tool call.
  - Helpers show in start order: oldest `startedAt` first, queued runs (no `startedAt`) last, ties by id.
    pi-subagents sends them newest activity first, so running helpers would swap places. Steps keep their order.
  - Each run in state `running` counts against `agents.maxLive` with the agent processes. It makes a new agent wait
    for a slot but never stops a run that exists. A queued run counts nothing. An agent with a running helper does
    not stop for idleness, and the Stop button of the chat is disabled.
  - The agent view carries `helpersRunning`, the count of `running` runs, left out when 0. A change of the count is
    an `AgentChange` of kind `helpers`, so `agents:list` and Home follow it.
  - Other modules read the whole list with `AgentsKey.liveState(agentId)`: `{ model?, routedModel?, children }`,
    the in-memory model, the physical model of the newest answer when it differs (`routedModel` in
    `packages/shared/src/chat.ts`, which the chat page uses too), and the child runs. Any change of the list (a run,
    a step, a state, a current tool, or the empty list at process exit) is an `AgentChange` of kind `children`.
    `agents:list` and Home ignore it; the agent graph follows it (section 11g, ADR 0176). An idle chat with a running helper shows
    as working: "Working (helper running)" in the workspace list and on Home, `working (helper running)` in the chat
    header. It is not done; its process gets the helper's result.
  - Another module can mark an agent as working for something with `Agents.setWorkingFor(agentId, source, label)`,
    for example a chat that waits on a pipeline run. `source` is the caller's module id. A label is per source, in memory
    only, so two modules do not overwrite each other. The view's `workingFor` joins the labels in source name order with
    `"; "`. A change of it is an `AgentChange` of kind `working`. `undefined` clears that source's label. It never touches
    `waitingSince`.
    An idle or stopped chat with `workingFor` shows as working: Home has a running item with status `pipeline` and
    the label as its detail, and no `finished` item, unless the pipeline's stage chat takes that workspace's row
    (section 11b); the workspace line is `Working (<label>)`, and the chat header `working (<label>)`. A wait for
    the user and a failed agent still win. The pipelines module sets the label
    under source `pipelines` for the chat of each `running` run. The runs module sets source `runs` on a run's
    coordinator while a lane merges: `Merging lane "<name>": <step>` (section 9).
  - A workspace can carry a working label too: `Agents.setWorkspaceWorkingFor(workspaceId, label)`, in memory only.
    `undefined` clears it; a deleted workspace loses it. Topic `agents:working` sends `{ type: "working",
    workspaces }`, the whole map, on subscription and after each change. `workspacesWorkingFor()` reads the map and
    `onWorkspaceWorkingFor(listener)` hears each change, for Home. The pipelines module labels the workspace of each
    `running` run, so a run lane at `gates` or between stages shows as working, with or without a worker chat.
  - `GET /api/agents/:id/children/:runId/transcript?child=<step id>` sends `/subagents-inspect-rpc` to the agent's
    process (it runs even during a turn) and returns the `subagent-inspect` reply as `{ transcript }`. 404
    `child_not_found` for a run not in the list or an agent that is not running, 400 `bad_child_id` for an id with
    characters other than letters, digits, and `: _ . -`, 503 when pi-subagents does not answer in 10 s or fails.
  - The chat's Transcript button asks once per step, with the step id as `child`. pi-subagents records a running
    run's session file only on its step, so a run-level read has no messages until the run ends. A run without
    steps is read at run level. An empty reply shows "No messages yet." While the run is running and the
    transcript is open, the page reads it again every 3 s.
  - Side chats have no subagent tools (ADR 0033), so they have no helpers.

## 3. Repo layout

```text
packages/
  module-api/   module contract types, host interface, error types, web API context
  shared/       domain types, API schemas, and helpers used by server, web, and CLI
  server-core/  Hono app, request guards, store, lock, token, module setup, test server
  server/       the runnable server: startup and the plain-list module registry
  ui/           shared web components, stylesheet, and themes (Tailwind + Radix, ADR 0029)
  web/          React app shell (top bar, rail, theme menu) and web module registry
  cli/          pi-spore CLI over the HTTP API, and the commands that run the server (ADR 0184)
modules/<id>/   one npm package per module, @pi-spore/mod-<id>
  src/server.ts server entry: exports the ServerModule and any interface keys and types
  src/web.tsx   web entry: exports the WebModule (pages)
  src/*.test.ts tests, run against server-core's test server (modules/hermes keeps them in test/)
pi-extensions/
  spore-bridge/ workbench tools for agents (loaded with -e)
  router/       router virtual model; also installable into plain pi
pi-skills/
  project-wiki/ docs index and docs lint skill (loaded with --skill, ADR 0193)
docs/           vision, architecture, decisions, open questions
```

## 4. Module contract

See [ADR 0003](decisions/0003-modules.md).

```ts
// packages/module-api
export interface ModuleManifest {
  id: string;                  // unique, kebab-case
  requires: readonly string[]; // ids of modules this one needs
  core: boolean;               // core modules cannot be disabled
}

export interface ServerModule extends ModuleManifest {
  setup(host: ServerHost): void | Promise<void>;
}

export interface WebModule extends ModuleManifest {
  setup(host: WebHost): void;
}

export interface WebHost {
  api: ApiClient;                         // HTTP, live events, and module socket URLs
  addPage(page: WebPage): void;           // a hash route; `rail` adds an icon to the left rail
  provide / use                           // as on the server
}

export interface ServerHost {
  settings: Settings;                     // declare keys, resolve values with their source (section 13)
  store: Store;                           // SQLite, module-owned tables via migrations
  jobs: JobRunner;                        // durable jobs (section 6)
  events: EventBus;                       // typed server events, pushed to the web over ws
  routes: RouteRegistrar;                 // Hono routes under /api/<module id>/
  sockets: SocketRoutes;                  // WebSocket routes under /api/<module id>/ (section 15)
  provide<T>(key: InterfaceKey<T>, impl: T): void;  // export an operation or interface
  use<T>(key: InterfaceKey<T>): T;                  // only keys of modules in `requires`
  log: Logger;
  onStarted(listener): void;              // awaited after every module's setup, before the server listens
  pruneResponses(before: number): number; // deletes stored API responses older than `before` (ADR 0121)
}
```

- One plain-list registry in `packages/server/src/modules.ts` and one in `packages/web/src/modules.ts`.
- The web shell has a top bar (theme menu, server status dot), a left rail, and the page area. A page with
  `rail: { order, icon }` gets a rail icon, lit on its path and every path below it. Full pages wrap their content
  in `Page` from `@pi-spore/ui`; the workspace view fills the area itself.
- Phones (ADR 0159): below 768 px (`max-md:`; `usePhone()` in `packages/ui/src/phone.ts` for JS) the rail links
  move into the top bar, controls are at least 44 px tall, and fields use 16 px text, so iOS does not zoom on focus.
  The 16 px rule in `packages/ui/src/styles.css` is unlayered, so it beats the `text-sm` and `text-[15px]`
  utilities; a zoom that starts on focus stays after a return to the app. A page that shows one pane
  at a time keeps the open pane in the hash, `#/<path>?pane=<name>`; the router ignores the query. `openPane`,
  `switchPane`, and `closePane` change it, and Back closes a pane. The root follows `visualViewport` so the
  composer stays above the on-screen keyboard; its top follows `offsetTop` only while the keyboard is open. The
  document never scrolls: `html` and `body` hide overflow, and `lockDocumentScroll` cancels a one-finger drag that
  no inner scroller can use (ADR 0185). `followVisualViewport` sets `data-keyboard-open` on `<html>` while the
  keyboard is open. While it is set and a text field has focus, rows marked `data-hide-while-typing` (the top bar
  and the workspace pane row) are hidden by one CSS `:has()` rule in `packages/ui/src/styles.css`; they come back
  when the keyboard closes or the field loses focus. When the page is hidden, the focused text field is blurred;
  on resume the viewport is read now and again on the next frame (ADR 0190). If the viewport is then more than
  4 px shorter than the largest height seen with no focused field, iOS has kept a stale height: `#root` is set to
  `display: none` and back, with a forced reflow between, so WebKit measures again; scroll positions are kept. The
  same heal runs a frame after a `visualViewport` resize with no focused field (ADR 0192). The heal skips a zoomed
  page (`scale > 1`). The chat header and the chat bar are one row on a phone: a chat picker, the state chip,
  and a "Chat actions" menu (`Menu` from `@pi-spore/ui`) with the context %, Compact, Stop agent, Rename, New chat,
  Side chat, Side chat with context, and Close this chat. The composer is shorter on a phone and keeps one button row:
  while the agent works, Stop takes the place of the model and thinking controls, and the send button is a split
  button whose arrow menu picks Steer (the default) or Follow up.
  Hover-only controls also show with `touch:` (`@media (hover: none)`). `packages/web/public` holds the web app
  manifest, the icons, and the service worker `sw.js` (ADR 0196; push and notification taps only, no `fetch`
  handler, no cache). At 768 px and above nothing changes.
- Confirmations use `useConfirm()` from `@pi-spore/ui`, never `window.confirm`. It returns `{ confirm, dialog }`:
  render `dialog` once, and `await confirm({ message, title?, confirmLabel?, tone?: "danger" })` for a boolean.
  The dialog is themed, focuses Cancel first, and answers false on Cancel or Escape. A test fails if
  `window.confirm` appears in `packages` or `modules`.
- `server-core` holds everything except the registry, so module tests can use its test server without a package
  cycle (server → modules → server-core).
- Startup validation, each failure stops the server with a clear message:
  - ids are unique;
  - every required module is present and enabled;
  - core modules are not disabled;
  - the dependency graph has no cycle.
- Setup runs in dependency order. Then the job runner resumes jobs (section 6), and `onStarted` listeners run in the
  same order; a throw is logged and does not stop startup.
- Server-only helpers are in `@pi-spore/module-api/node`, so the web bundle never imports Node modules:
  `removeInside(root, target)` deletes a path only when it is inside `root`, also through symlinked folders.
- A module reaches another only through `host.use()` with an `InterfaceKey` that the other module exports. It never
  imports another module's internals. Biome import rules enforce this.
- Core modules: `projects`, `vcs-git`, `vcs-folder`, `workspaces`, `agents`, `chat`, `artifacts`, `attention`.
  `bridge` (spore-bridge's routes) is not core, because it needs `actions`.
- `pi-extensions/` packages are not modules. They run inside Pi. A server module may import a pi-extension package's
  library entry for its file formats, as `usage` does with `@pi-spore/router`.

## 5. Domain model

| Entity | Meaning | Key fields |
|---|---|---|
| Project | A registered Git checkout or folder | id, name, path, vcs kind, detected traits (`unity`) |
| Workspace | One piece of work | id, project, name, slug, isolation, path, branch, base (what a new branch started from), state (active, parked, archived), archived at, card, planner (the project's planner workspace, ADR 0174), archive on merge (unset follows the setting, ADR 0197) |
| Agent | One Pi conversation (a chat) | id, workspace, role (`orchestrator`, `planner`, or a stage role), kind (worker, side, stage), active, closed, closed at, title, forked from, model selection, session path, process state, parent agent |
| Run | A coordinator conversation that owns lanes | id, project, run workspace, run line (`run/<slug>-<id>`), base, gates, coordinator agent |
| Lane | A workspace inside a run | id, run, name, wave, depends on, brief artifact, pipeline, model, state, workspace, approval, message |
| Pipeline | A declared stage list (file) | id, source (user, project, or built-in), stages |
| PipelineRun | One pipeline execution on a workspace | id, workspace, pipeline id + content hash, stages, brief, asking chat, worker agent, state, current stage, message, test manifest, approval |
| Turn | One prompt to a stage agent and its report | id, run, stage, round, kind (task, fix, review), role, agent, report (verdict, findings, tests, Jev answer), error (the agent failed and Retry replaced it), model note (a reviewer default on a full plan was swapped) |
| Question | A question going up the chain | id, from agent, to (coordinator or user), body, answer, state; a lane's question is a `runs_questions` row |
| Approval | A decision gate on Home (ADR 0100) | id, kind (`card-start`, `lane-model`, `run-pr`, `unity-close-editor`, pipeline gates), asking agent, workspace, title, reason, subject, state (open, approved, declined), outcome |
| Card | A kanban card | id, project, column, position, title, body, labels, due, model, blocked by, workspace, archived at, created by and changed by (agent) |
| EditorLease | Who holds the Unity editor of a project | project, worktree path, owner (user or agent), pid |
| RoutingDecision | One router choice (a line in `usage/routing.jsonl`, not a table) | kind, route, model, reasons, Jev answers, token estimate, plan windows seen, explore, session, agent, workspace |
| Outcome | How a pipeline run with a worker ended (`usage_outcomes`, ADR 0144) | run, workspace, worker agent, state, verdict of the first reviewer stage, review rounds, fix passes, ended at |
| UsageSnapshot | Latest plan window numbers (a file per plan, `usage/<plan>.json`) | plan, window (5h, 7d), utilization, resets at, seen at, source |
| Job | A durable unit of background work (`core_jobs`) | id, kind, key, subject, state (running, waiting, interrupted, done, cancelled), step, checkpoint, run at, started at, attempts, error |

## 6. Persistence and durability

See [ADR 0004](decisions/0004-state-in-sqlite.md).

- One SQLite file, `~/.pi-spore/data/pi-spore.sqlite`, through `node:sqlite`. It is built into Node, so there is
  no native module to build. It supports FTS5 for the v2 search.
- A lock file next to it. A second server refuses to start.
- Each module owns its tables and ships numbered migrations.
- **Jobs.** PR watching, deliveries, pipeline stages, lane starts, and lane merges are jobs. Core owns the
  runner (`host.jobs`, `packages/server-core/src/jobs.ts`) and its table `core_jobs`:
  - A module defines a kind (`<module id>.<name>`) as a list of named steps during setup, and starts jobs with
    `jobs.start(kind, subject, { key, after })`. Start is a plain insert, so it joins the caller's transaction; the
    job runs only if that commits.
  - A step does its async work, then returns an outcome: a `commit` function with its store effects, a checkpoint,
    the next step (default the next in the list; `null` ends the job), a delay (`after`), or `wait`. The runner
    runs `commit` and writes the next step, checkpoint, and due time in one transaction. It first checks that the
    job is still running on the same step, so a late result of a cancelled or retried job writes nothing.
  - Jobs with the same kind and key run one at a time, oldest first; a waiting or interrupted one blocks the later
    ones, so deliveries keep their order. `jobs.wake(kind, key)` makes waiting jobs due again; a wake during a
    running step applies when it settles. A step that throws makes its job `waiting` with the error; waiting jobs
    run again on a wake, a retry, and a server start. `jobs.retry(id)` does the same for one job; a module can retry
    only jobs of its own kinds.
  - After every module's setup, the runner resumes running and waiting jobs on the step they were on, so a
    committed step never runs again. A delayed step keeps its due time. Jobs of a kind no enabled module defines
    are left as they are.
  - A step marked `agentTurn` that was cut off is not run again: its job becomes `interrupted` and shows on Home
    with Retry and Cancel. Pipeline stages do not use it: their `await` step waits for the turn's report and, after a
    restart, asks the agent once to continue (section 8).
  - `GET /api/jobs?state=` lists jobs (default: not ended), `POST /api/jobs/:id/retry` runs an interrupted or
    waiting job's step now, `POST /api/jobs/:id/cancel` ends one. A wrong state is 409.
- **Deliveries.** A question, answer, or lane result to an agent is a row in `agents_deliveries`, written through
  `AgentsKey.deliver` in the same transaction as the change that causes it (answering a question writes the answer
  and the delivery together). The agents module sends it as a prompt: it starts the process if needed, and sends a
  follow-up if the agent is busy. The row is marked `done` when Pi accepts it. No polling by agents.
  - Each row has an `agents.delivery` job keyed by the agent, written in the same transaction. Its one step waits
    while the workspace or the chat is not active, and after a failed send (the row records attempts and the
    error). It is woken when the agent becomes idle, when its workspace is resumed, when its chat is made active,
    and when a new message for the agent comes. A parked or archived workspace keeps its rows.
  - The error of the agent's oldest pending delivery shows on the agent as `deliveryError`. The chat shows it in place
    of its empty state. Setting or clearing it publishes the agent and fires `onChange(agentId, "delivery")`, so a
    pipeline stage whose task Pi refused (such as a provider with no API key) blocks instead of waiting forever.
  - Delivery is at least once: a crash between Pi's accept and the `done` write sends the message again.
- **Idempotency.** Mutating API requests carry an `Idempotency-Key`. The response is stored and replayed for a repeat
  of the same key. Server errors (5xx) are not stored, so a retry runs again. Retention deletes stored responses
  older than `retention.days` (section 14).
- **Receipts.** Mutating spore-bridge calls send the tool call id as their `Idempotency-Key`. The server scopes it to
  the calling agent (`bridge/<agent id>/<tool call id>`), so a replayed tool call returns the first result
  (R16.3, ADR 0032).
- This is weaker than Pi Durable in one place: a model turn cut off by a crash is not replayed token by token. Pi's
  session file keeps everything up to the last completed message, and the job decides how to continue.

## 7. VCS providers

See [ADR 0005](decisions/0005-vcs-providers.md) and [ADR 0090](decisions/0090-changes-and-pull-requests.md).

```ts
export interface VcsProvider {
  kind: string;                                          // "git" | "folder"
  priority: number;                                      // higher runs first; folder is the fallback at 0
  detect(path: string): Promise<boolean>;
  root(path: string): Promise<string>;
  isolationModes: readonly Isolation[];                  // new, existing, in-place
  createCopy(project, request): Promise<WorkspaceLocation>;   // { path, line?, base? }
  lostWork(project, location): Promise<string | undefined>; // why removeCopy would refuse; undefined for none
  removeCopy(project, location, { force }): Promise<void>;
  // Optional capabilities, detected by presence:
  lines?: { list(project) };                             // branches (git)
  changes?: ChangeOps;                                   // scopes, files, diffs, records (git)
  publish?: PublishOps;                                  // push a line, never force (git)
  integrate?: IntegrateOps;                              // join lines in a run's copy (git)
}

interface IntegrateOps {                                 // ADR 0150
  createLine(project, line, base): Promise<void>;        // a branch at base, not checked out
  merge(location, line): Promise<{ conflicts: string[] }>; // no commit; on a conflict it aborts and lists the files
  commit(location, message): Promise<string>;            // commits the merge in progress
  abort(location): Promise<void>;                        // undoes a merge in progress, if any
  diff(location, line): Promise<string>;                 // what line adds since it left the copy's line
}

interface ChangeOps {
  scopes: readonly ChangeScopeKind[];                    // uncommitted, staged, line, record
  defaultBase(project): Promise<string | undefined>;
  head(location): Promise<string | undefined>;
  records(location, base, limit): Promise<ChangeRecord[]>;
  files(location, scope, limit): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  diff(location, scope, file, limits): Promise<FileDiff>;
}
```

- Words in the interface are neutral ("line" for branch, "record" for commit), so Perforce could fit later. A
  forge (GitHub) is not a VCS: pull requests live in the `github-pr` module, which uses `publish` to push.
- Nothing outside a provider branches on `kind`.
- Providers run `git` and `gh` with `execFile`, never through a shell.
- New worktrees run the copy list (R2.6) and then the `setup` action. A new branch records its base: the branch
  asked for, else the main checkout's branch, else its commit. The git provider starts the branch from the base's
  upstream when the base tracks a remote: it runs `git fetch <remote>` (a failure is a warning; a remote whose
  `remote.<name>.fetch` writes outside `refs/remotes/` is not fetched, so a fetch never moves a local branch), and if
  the local base is behind its upstream, local upstreams (`.`) included, the branch starts at the upstream commit.
  The local base branch never moves.
- Git changes (`modules/vcs-git/src/changes.ts`):
  - Scopes map to two endpoints of `git diff`: `uncommitted` is HEAD against the working tree plus untracked files
    (`git ls-files --others --exclude-standard`, each diffed with `--no-index` against `/dev/null`); `staged` is
    `--cached`; `line` is the merge base with the base against HEAD; `record` is the commit against its first
    parent. With no commit yet, the empty tree stands in for HEAD.
  - Every diff runs with `--no-color --no-ext-diff --no-textconv -M`, so user diff drivers never run and the output
    has one format. Lists come from `--name-status -z` and `--numstat -z`; one file's hunks from a diff limited to its
    paths. A line the parser does not know is an error, not a guess.
  - A base or record id goes through `git rev-parse --verify --end-of-options <name>^{commit}` first, so a name that
    looks like an option stays a name. Record ids must be hex.
  - Binary files and files over the limits (lines, bytes) get a note instead of hunks.
  - `defaultBase`: the branch `origin/HEAD` points at (local if it exists, else `origin/<name>`), else `main`, else
    `master`.
  - `push`: the branch's configured remote, else `origin`, else the only remote. `git push --set-upstream <remote>
    refs/heads/<line>:refs/heads/<line>`, never `--force`; a rejected push is 409 `push_failed` with git's message.
    `GIT_TERMINAL_PROMPT=0`, so a missing credential fails instead of waiting.
- Git integrate (`modules/vcs-git/src/integrate.ts`): `merge`, `commit`, and `abort` first read the copy's current
  branch and refuse with 409 `not_run_line` unless it starts with `run/`. That is the code-level rule that pi-spore
  never merges into a base line (R9.3). `merge` runs `git merge --no-ff --no-commit`.

## 8. Pipelines

See [ADR 0006](decisions/0006-declared-pipelines.md), [ADR 0015](decisions/0015-review-rounds.md),
[ADR 0016](decisions/0016-fail-first-proof.md), [ADR 0199](decisions/0199-proof-by-breaking-the-code.md), [ADR 0140](decisions/0140-pipeline-stage-agents.md),
[ADR 0158](decisions/0158-revise-lane-is-a-fix-pass.md), [ADR 0162](decisions/0162-orchestrator-starts-pipeline-runs.md),
[ADR 0178](decisions/0178-parallel-reviews-and-early-gates.md), and [ADR 0187](decisions/0187-pause-and-resume-a-pipeline-run.md). Requirements R6, R4.4,
R4.9.

The `pipelines` module (not core, requires `projects`, `workspaces`, `agents`, `artifacts`, `attention`,
`actions`) runs declared pipelines on a workspace. A run needs no coordinator run (R6.8).

Pipeline files are TOML (`smol-toml`, as config.toml): `~/.pi-spore/pipelines/<id>.toml` (source `user`) and
`<project>/.pi-spore/pipelines/<id>.toml` (source `project`). A project file with the same id wins. The file's `id`
must equal its file name. A built-in `default` is used when no file has id `default`:

```toml
id = "default"

[[stage]]
name = "implement"
role = "worker"
tier = "route"            # spore/auto (R4.9)

[[stage]]
name = "review"
role = "reviewer"
rounds = 2                # the most reviewer runs; a fresh read-only agent each round
early_stop = "jev"        # Jev may end the review early; it never adds a round
fix_passes = 1            # a REVISE on round 2 gets one fix, with no review after it
min_strength_over = "implement"   # a cloud worker may be reviewed by its own tier; a local worker needs a higher tier

[[stage]]
name = "adversarial"
role = "adversarial-reviewer"
with_previous = true      # runs next to review; its findings join the same fix
rounds = 1
fix_passes = 1            # a REVISE on the last round gets one fix, with no review after it

[[stage]]
name = "gates"
with_previous = true      # runs while the reviewers read; runs again after every fix
gates = ["check", "test"] # action names from config.toml
fail_first = "artifact"   # every new test needs its proof artifact (ADR 0016, ADR 0199)
```

A built-in `light` is used the same way when no file has id `light`. It is `default` without the `adversarial`
stage. The orchestrator picks `light` or `default` for each slice and names it in the plan the user approves
(ADR 0162):

```toml
id = "light"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "review"
role = "reviewer"
rounds = 2
fix_passes = 1
early_stop = "jev"
min_strength_over = "implement"

[[stage]]
name = "gates"
with_previous = true
gates = ["check", "test"]
fail_first = "artifact"
```

A built-in `revise` is used the same way when no file has id `revise`. The runs module starts it for `revise_lane`
(ADR 0158):

```toml
id = "revise"

[[stage]]
name = "fix"
role = "worker"
worker = "reuse"          # the worker of the previous run gets the brief; no new agent

[[stage]]
name = "review"
role = "reviewer"
rounds = 1
fix_passes = 1            # a REVISE gets one last fix, with no review after it
min_strength_over = "fix"

[[stage]]
name = "gates"
with_previous = true
gates = ["check", "test"]
fail_first = "artifact"
```

- Checks: unknown keys, keys of the other stage kind, and bad values are 422 `bad_pipeline` naming the file. The
  first stage, and only it, is the `worker` stage. A stage sets `model` (`provider/id`) or `tier`, or neither (the
  role default). Only `tier = "route"` is built; other tiers are an error that says so. `model` is refused in
  project files (R17.3). `worker = "reuse"` is allowed only on the worker stage, and not with `model` or `tier`.
  `rounds` defaults to 1, `fix_passes` (0 or 1) to 0. A per-stage thinking level is not
  built (R6.1); it comes from the role default.
- **Parallel groups** (ADR 0178). A reviewer or gate stage with `with_previous = true` joins the group of the stage
  before it; `stageGroups` in `@pi-spore/shared` lists the groups. The key on the worker stage or the stage right
  after it is 422 `bad_pipeline`. `default` groups `review`, `adversarial`, and `gates`; `light` and `revise` group
  `review` and `gates`. How a group runs is under "Parallel review rounds" and "Gates".
- `GET /api/pipelines/workspaces/:id` lists the pipelines a workspace can start; a bad file shows its error and
  never falls back to the built-in one.
- **Runs** (`pipelines_runs`, `pipelines_turns`). `POST /api/pipelines/workspaces/:id/runs` `{ pipeline, brief, name? }`
  stores the file's SHA-256, its parsed stages (an edit never changes a running run), the brief, and the asking chat
  (the active orchestrator chat). One run per workspace is `running` or `waiting_user` (409 `pipeline_running`).
  States: `running`, `waiting_user`, `passed`, `failed`, `stopped`. `name` (1 to 80 characters, column `name`) is
  the slice's label only; the run returns it when set. The orchestrator passes the slice's name from its plan; a lane
  run gets the lane's name.
- **From the orchestrator** (ADR 0162). The bridge route `POST /api/bridge/pipelines` `{ brief, pipeline?, name? }` reads
  `brief` as an artifact path of the caller's workspace (404 `brief_not_found`) and calls `PipelinesKey.start` with
  `pipeline` (default `default`) and the caller as the asking chat. Side chats are refused (403 `read_only_chat`).
  The tool call id is its Idempotency-Key, so a replayed call starts no second run.
- **End message** (ADR 0162). When a run that is not a lane ends (`passed`, `failed`, or `stopped`), its asking chat
  gets one message in the transaction that ends it: the run, its workspace, the state, the failure or stop text, and
  the last review's verdict and findings. A passed run's message says to read the diff. A lane run gets none: the
  runs module tells its coordinator (section 9).
- **Reuse** (ADR 0158). `PipelinesKey.start` takes `previousRunId`, a run of the same workspace with a worker. A
  pipeline whose worker stage has `worker = "reuse"` needs it (400 otherwise), refuses `workerModel`, and any other
  pipeline refuses `previousRunId`. The run stores it and the workspace head at start (`fix_base`). Its worker stage
  makes no agent: the previous run's worker gets the brief as its task turn. Its reviewers also get a fix diff
  `pipelines/<run>/<stage>-<r>-fix.diff` (commits since `fix_base`, then uncommitted and untracked files) and the
  previous run's last review, and are told to check that the brief's asks are met and nothing broke, with the same
  REVISE rule as round 2. Runs never stop their agents, and a delivery starts a stopped one. `PipelinesKey.get`
  returns a run's view, with `workerAgentId`.
- **Stage jobs.** Each group is a `pipelines.stage` job keyed by the workspace; a stage alone is a group of one. The
  job's `stageIndex`, and the run's `stage_index` while it runs, is the group's first stage. Steps: `advance` (start
  the next turns), `await` (wait for every open turn of the group and run its gates), `decide` (apply the
  verdicts and red gates), and `finish` (start the next group's job in the same commit, or end the run `passed`). A turn's row, its stage agent, and the prompt's delivery commit
  together. Prompts name the turn on a `Turn: <id>` line, and the brief is the workspace artifact
  `pipelines/<run>/brief.md`. A worker's task prompt also holds the brief's full text under `## Brief`, so
  `spore/auto` scores the real task on a new worker's first message (ADR 0144).
- **Reports.** The bridge passes `report` calls to `PipelinesKey.report`. Only the turn's agent may report (403
  `not_your_turn`), once per turn (a repeat returns the stored turn; an older turn is 409 `turn_closed`; the other reviews of the same group
  round do not close a turn). Reviewers
  must give a verdict and no tests; the worker gives no verdict. Worker tests join the run's manifest by name, so a
  later report never drops a test.
- **Uncommitted work** (ADR 0195). A worker's report is checked against the workspace's uncommitted, staged, and
  untracked files, read through `ChangeOps.files` (gitignored files do not count; a project without `ChangeOps` skips
  the check). The first report of a turn with such files is refused with 409 `uncommitted_changes`, which names the
  paths and says to commit, then report again. Column `commit_reminded` on the turn records it, also across a
  restart. A later report is taken. `decide` checks the workspace each time it runs, so after every report, review
  round, and gate round, and before `passed`. Files there block the stage with
  `uncommitted changes in <workspace>: <n> files (<first paths>). Commit them, then Retry.` Retry runs `decide` again.
- **Restarts** (R6.6). The `await` step keeps the server's boot id in its checkpoint. After a restart it sees another
  one and tells each agent of an open turn once to continue and call `report`. Turns that reported do not run again.
  If an agent ends its turn without a report, the step reminds it once per turn (column `reminded` on the turn, also
  across a restart); a second such end blocks the stage
  (ADR 0169). A turn that ends on a model server error gets one nudge too (ADR 0201, below). There are no other
  automatic reminders.
- **Pause** (ADR 0187). `paused_at` on the run pauses it; the run stays `running` and its view has `paused: true`.
  The open turn is not cut off, and its report is kept. `advance`, `decide`, and `finish` wait while the run is
  paused, and a step that ends on a paused run takes no effect. `await` reminds no one and blocks nothing while
  paused, and it checks again after each session read. The first `await` after Resume sends each open turn's agent
  that is not busy and has no open question one message ("The user resumed the pipeline. Finish the work, then call
  report with this turn."), sets its `reminded` back to 0, and covers the restart reminder. A paused run survives a
  restart, holds the workspace, and can be cancelled. Agents have no pause tool.
- **Stage questions** (ADR 0179, `pipelines_questions`). `ask_orchestrator` reaches `PipelinesKey.askStage`. It
  refuses a caller that is not a stage agent (403 `not_a_stage`), a stage agent of a lane (403 `in_lane`), and a
  caller that is not the agent of an open turn (409 `turn_closed`). An open turn is a turn of a `running` run with no
  report and no error; a parallel review group has several (ADR 0178). The question goes to the run's asking chat.
  When the user closed that chat (or retention deleted it), it goes to the workspace's active worker chat
  (`agents.activeWorker`), and that chat becomes the run's asking chat, so it also gets the end message. The row and
  the delivery of the question commit together. The message names the run, the stage, the agent, and the question id,
  and says to answer from the plan with `answer_stage`, or to ask the user with `request_human_input` first.
  `answer_stage` reaches `PipelinesKey.answerStage`: 404 `question_not_found`, 403 `not_asked` for any chat but the
  asked one, 409 `question_answered`, and 409 `turn_closed` when the question's turn is no longer open. The answer and
  its delivery to the stage agent (with the `Turn:` line) commit together; the delivery starts the agent's next run.
  An open turn with an open question gets no reminder, no block, and no restart reminder; the `await` step waits for
  it. It checks again after it reads the agent's session, because the agent may ask during that read. A failed agent
  still blocks the stage. The run view sets `question` on each open turn with an open question, and the Pipeline tab
  shows "Waiting for an answer from <chat>." with a link to that chat (in `askedWorkspaceId`) and the question.
  In a lane, the open question is the agent's `ask_coordinator` question since the turn started. The pipelines module
  reads it through the lane lookup the runs module sets (`setLaneLookup`, ADR 0003), and the asked chat is the
  coordinator in the run workspace. `askCoordinator` and `answerLane` call `laneQuestionChanged`, so the Pipeline tab
  updates.
- **Stage chat titles.** A run with a slice name (`name`) titles its stage agents `<slice name> - <stage title>`, such
  as `push_line tool - Review 1`. Without a name the titles stay `implement`, `Review 1`, ... A reused worker (`worker =
  "reuse"`) is renamed to the new run's slice name when the run has one, in the same commit that gives it the task, so
  its tab names the run that uses it now. Without a name it keeps its title. The `(failed)` suffix goes on the end.
- **Failed turns** (ADR 0140, ADR 0198). The pipeline listens to the stage agents' status. When the open turn's agent
  fails (`turnError`: a crash, a turn that ended with `stopReason: "error"`, or a task Pi refused to take), the `await`
  step throws `stage <name>: the <role> agent "<title>" failed: <error>. Retry tells the same agent to continue. Fresh
  agent starts a fresh <role> agent for this turn.` A failure with a `provider` says `the model server <provider>
  failed for the <role> agent "<title>": <error>` instead. The job waits with that error, so the run stays `running`
  and shows it as `blocked`. A turn that ended twice without a report blocks the same way (`... ended its turn twice
  without a report ...`, ADR 0169), and both choices cover it. The old agent may still report while the run is
  blocked.
  A model server error first gets one nudge (ADR 0201): when the failure has a `provider` and its text does not
  name a usage limit (`usage limit`, `quota`, `billing`, `out of budget`, `available balance`,
  `insufficient_quota`), and the turn's `error_nudged` is 0, `await` sends the same agent `Your model call failed:
  <error>.`, a line that tells it to check where it stopped and finish the turn, and the `Turn:` line, and sets
  `error_nudged` to 1. Only the next such error blocks. After a restart or a Resume, that message covers the nudge.
  Retry (`POST /api/pipelines/runs/:id/retry`) writes the raw failure on the turn's `retry_error`. The next `await`
  that is not paused sends the same agent one message, `Your last turn failed: <failure>. This is attempt <N> of this
  turn.`, a line that tells it to check where it stopped and finish the turn, and the `Turn:` line. In the same commit
  it raises `attempts`, sets `reminded` and `error_nudged` to 0, and clears `retry_error`. The other open turns get what the step gives
  them then (the resume or the restart message). A Pi process that exited starts again on its session file. The turn
  view has `attempts` from 2.
  Fresh agent (`POST /api/pipelines/runs/:id/fresh`) writes the error on the turn, and `await` then replaces it in
  one commit: the old agent is renamed `<title> (failed)`, keeps its tab, and loses its
  pending deliveries, and a fresh
  agent takes the turn. A task or review turn goes back to `advance`, so the round number stays and `min_strength_over`
  is checked again; a fix turn goes to a fresh worker with the same findings, and the run's worker becomes it. The fresh
  agent has the stage's or run's model, else the role default read when it starts, so a settings fix works. A fresh
  worker (task or fix turn) also gets a handoff note before its normal prompt, built by code from `agents.handoff`:
  `This is attempt <N> of this turn.`, the failed agent's title and failure (the block message without its choices
  sentence), its session file, its last message, its last tool calls (name and the start of the arguments, never
  results), and the worktree now from the provider's `changes` (uncommitted files, then files committed since the
  base, 30 each). The new turn row has `attempts` one more than the failed one, so the row and the note say the same
  N. A failed task of a `worker = "reuse"` stage also goes to a fresh worker, whose prompt is the normal "Implement
  the brief" one; the local-implementer question is not asked again. Reviewers get no note. A restart or
  another wake does not mark the turn, so it only blocks again. Retry also works while such a wake runs the blocked step
  again: it marks the turn and wakes the job, so the step runs once more after it settles. Failed turns do not count as
  rounds.
- **Review rounds** (R6.3, R6.4). Round r starts a fresh reviewer with the brief, the manifest with proof paths, and
  a diff artifact `pipelines/<run>/<stage>-<r>.diff` (commits since the base, then uncommitted and untracked files,
  from the provider's `changes`). The prompt asks for each test the brief suggests, and for a proof that shows each
  listed test can fail; the adversarial prompt also asks for each edge case or failure path no test covers (ADR 0199).
  Round 1 also gets the worker's task report summary, so the reviewer can read why a suggested test changed.
  From round 2 on, the prompt also has the previous round's summary and findings and
  the worker's fix report. It tells the reviewer to check each earlier finding first, to answer REVISE only for a
  bug, a missing or wrong test, a regression, or a break of the brief, to list style, naming, wording, and taste as
  `minor`, and to rate a new finding the previous round could have raised `important` at most. APPROVE ends the
  stage. REVISE sends the findings to the same worker as a fix
  turn, then round r + 1. Jev ends the stage after that fix instead when the stage has `early_stop = "jev"`, the
  report's `earlyStop.stop` is true, and no finding is blocking. A REVISE on the last round gets one last fix with
  `fix_passes = 1`; otherwise the run is `waiting_user` with a `pipeline-round-limit` approval on Home for the asking
  chat. Its title names the workspace, and for a lane the run and the lane id; the runs module gives pipelines that
  lookup through `Pipelines.setLaneLookup`, because runs requires pipelines. The reason lists the findings with their
  severity. The subject is `{ runId, stage, action }`, filed with `action: "fix"`. Its `decided` hook, in the
  decision's transaction, acts on the choice: `fix` starts one last fix turn with no review after it, then the stage
  ends; `accept` ends the stage without a fix; decline stops the run. Home shows the three as buttons, fix first.
- **Parallel review rounds** (ADR 0178). A group runs in rounds. Round r starts every open member in one commit; all
  of them read one diff, rendered once and written as each member's `<stage>-<r>.diff`. Round 1 opens every member.
  Round r + 1 opens each member that said REVISE in round r, has rounds left, and was not stopped by Jev. When every
  review of the round reported, one fix turn holds every REVISE, each under its stage name. The fix row has the
  group's first stage index and `fix_for`, the member names (view `fixFor`). The round rules above apply per member.
  One round-limit approval lists every member at its limit; accept drops their findings from the fix. A gate
  member runs every round; its red gates join the round's one fix, and accept keeps them.
- **Working label.** While a run is `running`, the pipelines module marks its chat with `Agents.setWorkingFor`, and
  its workspace with `Agents.setWorkspaceWorkingFor`, so Home and the workspace list do not show them as done:
  `Pipeline: <stages of the group, joined with ", ">`, with `, round <n>` from round 2 of a review stage, or
  `Pipeline: <n> runs` for a coordinator with lanes, or `Pipeline paused` for one paused run. The chat is the lane's
  coordinator, else the asking chat. A `waiting_user` or ended run gives no label. The module syncs it at every `publish`, at boot, and when the runs
  module calls `Pipelines.refreshWorking` after a new coordinator took over. A target that retention deleted (the
  chat, or the run workspace of a lane) is skipped.
- **min_strength_over** (R4.4, ADR 0023, 0152). Before a reviewer starts, its model (stage `model`, `spore/auto`
  for `route`, else the role default) must have a tier at or above every model in `modelsUsed` of the worker, and
  strictly above it when that model's tier is `local`. A cloud model may be reviewed by its own tier, the same model
  included, because the review runs in a fresh read-only chat. A missing model or tier, or a tier below, throws: the
  job waits with the error, shown on the run as `blocked`, and Retry checks again after the user fixes the settings.
  When the report comes, the reviewer's own `modelsUsed` is checked the same way; a failure ends the run `failed`.
  The worker's models are those of every worker agent of the run, a failed one included.
- **Local implementer** (R4.10, R3.4). Before the worker starts, its model is the stage `model`, else the worker role
  default. If that model is not `spore/auto`, its tier is not `local`, and its plan (`router.plans`) has fresh usage
  pressure (the router's thresholds), the run is `waiting_user` with a `pipeline-local-implementer` approval on Home
  for the asking chat, and no worker starts. Approve runs this run's worker on `spore/auto`; decline keeps the pinned
  model. The answer is stored on the run (`worker_model`), so a run asks once. Settings never change. A model with no
  tier or a provider with no plan is not asked about.
- **Reviewer plan** (R4.4, R4.10, ADR 0140, 0141). Before a reviewer starts on its role default (the stage sets no
  `model` and no `tier`), the default's plan (`router.plans`) is read. When it is `full` (a fresh window at 100%),
  the reviewer takes another model: the rung models of `router.ladders`, same tier first, then each higher tier, in
  ladder order, and the first whose plan is not full. A model with no plan (OpenRouter) or with no fresh numbers
  counts as having room, as in the router. The review turn stores the swap as `modelNote`, and the Runs page shows
  it. min_strength_over checks the chosen model. When no candidate has room, the step throws with the plan and its
  reset, so the run is `blocked` until Retry. A pinned stage model is never swapped. Settings never change.
- **Route** (R4.7). A worker report stores the newest `routing.jsonl` record for the worker agent on its turn
  (`routing`: route, model, reasons). A stage on a fixed model has none.
- **Turn model.** Every turn has `model` (`provider/id`): the physical model its agent answered on. The report
  stores it in `pipelines_turns.model`, so a reused worker that fixes on another model does not change an older
  turn. A turn of a running run with no report and no error reads it live from `AgentsKey.liveState`: the model of
  the newest answer, else the model the stage started the agent on. A stage agent's `activity` change (each
  `message_end`) publishes the runs event, so the tab follows it without polling.
- **Gates** (R6.5, ADR 0016, ADR 0178, ADR 0199). A gate stage is a group member like a reviewer; a gate stage alone is a
  group of one. `advance` opens the group's gate round with the review round: the job checkpoint holds `round` and
  each gate member's place (`places`: gate and attempt, by stage name). With `fail_first = "artifact"`, each test in
  the manifest needs a non-empty proof artifact, checked every gate round because fixes add tests; a missing one
  makes the member red with `missing fail-first proof for <test> (<proof>)` and runs none of its actions. `await`
  drives the gates without blocking, next to the open review turns: each gate runs through
  `ActionsKey.start(..., "pipeline", { key })` with the key `<run>:<stage>:<round>:<action>:<attempt>`, so a step that
  runs again gets the same action run back, and a re-run after a fix starts a new one. A queued or running action
  wakes the job when it ends. A run a restart cut off starts once more under the next attempt. Two gate members run
  at the same time; exclusive actions such as the Unity test gates queue per folder in the actions module (R12.2),
  so they take the editor lease in turn. No gate runs while a fix turn is open. A red member is stored on the run
  (`gate_reds`: round, stage, message, log path), because the round-limit answer and Retry build a fix outside the
  job. The message is `gate <action> failed`, the action error, the failed vitest tests (up to 10), and the last 4 KiB
  of the log, with no color codes.
  `gate_runs` (the run view's `gateRuns`) holds each member's state per gate round: `running` from when the round
  opens until its gates end, then `passed` or `failed`.
  - In a group with a reviewer, a red gate does not stop the reviews. When the round ends, every REVISE and every
    red gate go into one fix turn: each red gate gives its headline and `Log: <path>`. After every fix the gates run
    again, with the next review round, or alone when no reviewer is open (the final gate run). A red final gate run
    ends the run `failed`, with no fix.
  - A group with no reviewer (a gate stage alone) gets no fix: a red gate ends the run `failed` with its message.
  - The gates run only the final suite. The failing test runs of the proofs are never run again.
  - A gate action that config.toml does not declare blocks the run with the stage, the action, and the config.toml
    path to fix. A job stored on the old `gate` step goes back to `advance`.
- **Blocked message.** When a stage job waits with an error, the run's chat gets one message: the run, its
  workspace label (a lane names its lane, lane id, and run), the stage, the error, and that Retry runs the step
  again. A lane's message goes to its run's current coordinator, which the lane lookup gives; any other run's goes
  to its asking chat. `pipelines_runs.blocked_sent` holds the last error sent, so a retry that fails the same way
  sends nothing, also after a restart. A new error sends one new message.

| Route | Does |
|---|---|
| `GET /api/pipelines/workspaces/:id` | `{ pipelines }` |
| `POST /api/pipelines/workspaces/:id/runs` `{ pipeline, brief, name? }` | Starts a run (201). |
| `GET /api/pipelines/workspaces/:id/runs` | `{ runs }`, newest first, each with its turns and `blocked`. |
| `GET /api/pipelines/runs/:id` | `{ run }` |
| `POST /api/pipelines/runs/:id/retry` | Runs the run's waiting step now (409 `run_not_waiting`). A turn whose agent failed: the same agent continues (ADR 0198). |
| `POST /api/pipelines/runs/:id/fresh` | The same, but a turn whose agent failed gets a fresh agent (409 `run_not_waiting`). |
| `POST /api/pipelines/runs/:id/pause` | Pauses a `running` run (409 `run_not_running`). A repeat does nothing. |
| `POST /api/pipelines/runs/:id/resume` | Clears the pause and wakes the stage job (409 `run_not_paused`). |
| `POST /api/pipelines/runs/:id/cancel` | Stops a run. |

- Topic `pipelines:<workspace id>` sends `{ type: "runs", runs }` on subscribe and after every change.
- Web: a Pipeline tab (after PR) with a start form (pipeline, optional name, brief) when no run is active, and the
  runs, newest first. Only the newest run is open; an older run shows its header and step bar until clicked. A run
  shows a header line (the name, then the pipeline id as a chip, or the pipeline id alone; source, state, elapsed
  time, Pause or Resume on a `running` run, Cancel; a paused run's chip says `Paused`), a step bar with each stage's state and counts (a click scrolls to the stage; a parallel group is one box with its
  members side by side, each with its own state), the notices
  (message up to `GATE_LOG_HEADING`, so a gate failure shows its headline and failed tests; `blocked` with Retry, and Fresh agent when the run has an open turn),
  and a numbered timeline: every turn by `createdAt`, plus a Gates row that holds a failed gate's log in a closed
  block, ANSI codes removed. A fix row belongs to the worker stage and names the stages it fixes. Each row is one line (kind and
  round, verdict, finding counts, `model`, duration, `attempt N` from 2) and opens to the summary, findings by severity (minor closed),
  tests with proofs, the route, Jev's answer, and a link to the agent's chat. Only the newest or running row is open
  at first; the user's open and close choices stay when new data comes. A Details panel shows the latest run and its
  open findings. The current stage of a paused run shows a pause icon, not a spinner. A chat panel shows, above a
  stage chat's composer while its turn is open on a running run that is not paused: "The pipeline goes on after this
  turn. To stop it, use Pause on the Pipeline tab."
- CLI: `pi-spore pipeline list <workspace>`, `pipeline start <workspace> <pipeline> (--brief <text> | --brief-file
  <path>) [--name <text>]`, `pipeline runs <workspace>`, `pipeline show <run>` (both print the name when set),
  `pipeline cancel <run>`, `pipeline retry <run>`.
- Other modules use `PipelinesKey`: `start(workspaceId, { pipeline, brief, name?, askingAgentId?, workerModel? })` does what
  the start route does; `workerModel` sets the worker stage's model for that run only (column `worker_model`), so
  that run never asks about the local implementer. `start` and `requireModel(model)` refuse a model Pi's list lacks
  (400 `unknown_model`; `spore/auto` always passes); the runs module calls `requireModel` for a lane model.
  `afterRunEnded(listener)` runs for every run that ends, inside the transaction that ends it. The `usage` module
  uses it to record outcomes (section 11a). `onChange(listener)` runs with the workspace id whenever its runs
  change, as the topic does; the runs module uses it to show a lane's `blocked`. `runsOf(workspaceId)` returns the
  workspace's runs, newest first, as `GET /api/pipelines/workspaces/:id/runs` does.
- Not built yet: tiers other than `route`, a thinking level per stage, a brief preset from the card, moving the
  card when a run passes, and parallel groups (ADR 0178).

## 9. Runs and lanes

See [ADR 0007](decisions/0007-coordinator-runs.md), [ADR 0008](decisions/0008-questions-up-the-chain.md),
[ADR 0014](decisions/0014-lane-model-approval.md), [ADR 0017](decisions/0017-integration-branch.md),
[ADR 0150](decisions/0150-run-worktree-and-green-merges.md), [ADR 0151](decisions/0151-run-cancel-handover-and-pr-approval.md),
[ADR 0154](decisions/0154-coordinator-adds-cards.md), [ADR 0157](decisions/0157-finished-run-follows-the-active-chat.md), and
[ADR 0165](decisions/0165-finished-run-pushes-each-merge.md), [ADR 0180](decisions/0180-lanes-name-their-card.md),
[ADR 0182](decisions/0182-revise-lane-moves-a-lane-to-a-new-model.md), and
[ADR 0183](decisions/0183-decline-a-lane.md). Requirements R7, R4.8.

The `runs` module (not core, requires `projects`, `workspaces`, `agents`, `artifacts`, `attention`, `actions`,
`pipelines`) owns `runs_runs`, `runs_lanes`, and `runs_questions`. The bridge requires it.

- **Start.** `POST /api/runs` `{ projectId, name, base?, gates?, settings? }` needs a provider with `integrate` (else 422
  `not_supported`). `base` defaults to the main copy's current line; `gates` to `check` and `test`. It creates
  `run/<slug>-<last 6 of the run id>` at the base, the **run workspace** on it (isolation `existing`, with the base
  stored, so its PR tab targets the base), and its orchestrator chat. That chat is the coordinator. `settings` is
  the run's settings override (section 13); the run workspace and every lane workspace get it, with source `run`.
- **Coordinator.** A launch hook gives a `worker`-kind chat in a run workspace `PI_SPORE_RUN_ROLE=coordinator` and
  the allowlist `read,grep,find,ls,request_human_input,artifacts_list,artifacts_read,artifacts_write,
  kanban_list_cards,kanban_read_card,kanban_add_card,start_lane,revise_lane,merge_lane,decline_lane,
  answer_lane,open_run_pr,run_status,start_helper`: no write or shell tools, and no `subagent` (ADR 0194). Its token is not read-only, so it writes artifacts and calls the
  run routes. The hook also gives `role: "coordinator"` (`LaunchContext.role`, ADR 0181), so the coordinator starts
  on `subagents.agentOverrides.coordinator`, else `orchestrator`, else Pi's default. The chat row's role stays
  `orchestrator`. Every agent in a lane workspace gets `PI_SPORE_RUN_ROLE=lane`.
- **Follow-up cards** (ADR 0154). The coordinator adds a card for follow-up work out of the lanes' scope; it never
  changes or starts one. A card added from a run workspace goes to `backlog` with the label
  `from-run:<slug of the run name, up to 31 characters>`; the bridge sets both. A card change or start from a run
  workspace answers 403 `run_coordinator`. Lane agents keep all five card tools.
- **Lane cards** (ADR 0180). `start_lane` takes an optional `cardId`: the card the lane does, one at most. The lane
  stores it in `runs_lanes.card_id` and shows it as `cardId`. Runs does not require kanban: kanban sets a card
  linker with `RunsKey.setCardLinker`, and `startLane` calls it inside the transaction that stores the lane, so a
  refusal rolls the lane back. Without a linker a `cardId` answers 422 `cards_not_supported`. A card another lane of
  the run names answers 409 `card_in_lane`. Kanban's checks and the move are in section 12. `revise_lane` keeps the
  card; a cancelled, failed, or declined lane leaves it where it is.
- **Lanes.** `start_lane` takes a brief that is an artifact of the run workspace (404 `brief_not_found`), a wave
  (1 or more), lane ids it depends on (400 `bad_depends_on`), a pipeline (default `default`), and a model.
  - Model (R4.8, ADR 0014): no model, or one whose tier (ADR 0023) is not above the worker role default's, makes
    the lane `waiting`. A higher tier files a `lane-model` approval for the coordinator and the lane is `approval`.
    Approve makes it `waiting`; decline makes it `declined`. A missing role default or tier is an error that names it.
  - Job `runs.lane`, keyed by the lane: `ready` waits until every lane of a lower wave and every lane it depends on
    is `merged` (`declined` lanes do not block), then creates the lane workspace (`new`, base the run line);
    `launch` starts the pipeline with `PipelinesKey.start` (the coordinator is the asking chat, the lane model the
    worker model); `await` waits; `report` writes the lane diff to `runs/<run>/lanes/<lane>.diff` in the run
    workspace and delivers it to the coordinator, or delivers the failure.
  - `afterRunEnded` moves the lane to `passed` or `failed` in the pipeline's own transaction.
  - `revise_lane` sends a `passed` or `failed` lane back with a new brief (409 `lane_not_revisable` otherwise). It
    is the answer to a conflict, a red gate, or a cut. `launch` starts the built-in `revise` pipeline with the
    lane's last pipeline run as `previousRunId` (ADR 0158): the lane's worker chat gets the brief, then one
    reviewer and the gates check it. When that worker chat is gone (deleted or closed) or the lane has no earlier
    run, the lane's own pipeline runs from the first stage, and the coordinator is told why.
  - `revise_lane` with a `model` moves the lane to that model (ADR 0182). The model gets the same checks as a new
    lane's: 400 `unknown_model` when Pi cannot run it, and a `lane-model` approval for a higher tier, with the lane
    in `approval` (approve makes it `starting`; decline makes it `failed`, keeps its model, and tells the
    coordinator). The revise stores the model in `runs_lanes.new_model`. `launch` sees it, skips the reuse, and
    runs the lane's own pipeline from the first stage with a fresh worker on that model, in the same workspace.
    The commit that marks the lane `running` moves `new_model` into `model`. The coordinator is told.
  - `decline_lane { laneId, reason }` (bridge `POST /api/bridge/lanes/decline`) and the user's
    `POST /api/runs/:id/lanes/:laneId/decline` `{ reason }` (the Runs page's Decline button) drop a lane that will not
    merge (ADR 0183). Only a `waiting`, `passed`, or `failed` lane (409 `lane_not_declinable` naming the state). The
    lane becomes `declined` with the reason as its message, its waiting `runs.lane` job is cancelled, and waiting
    lanes wake. Nothing is merged or deleted. A user decline tells the coordinator. A decline that leaves a `running`
    run with every lane `merged` or `declined`, one merged, tells the coordinator to call `open_run_pr`.
  - States: `approval`, `waiting`, `starting`, `running`, `passed`, `failed`, `declined`, `merging`, `merged`,
    `cancelled`.
- **Merge** (ADR 0150). `merge_lane` takes a `passed` lane (409 `lane_not_mergeable`), makes it `merging`, and
  starts job `runs.merge`, keyed by the run, so merges go one at a time. `merge` aborts any merge a restart left,
  then merges the lane line into the run worktree without a commit. A lane line that adds nothing to the run line
  (an empty `integrate.diff`) is not merged: the lane goes back to `passed` with the message
  `empty lane: its branch adds no commits`, and the coordinator is told that its worker may have left work
  uncommitted (ADR 0195). `finish` still skips the commit when the diff is empty, because then a restart already made
  it. A conflict aborts, puts the lane back to
  `passed`, and sends the files to the coordinator. `gate` runs each run gate on the merged tree through
  `ActionsKey.start` with a key per merge job and attempt. `finish` commits when all passed (`merged`, wakes waiting
  lanes); on a red gate it writes the diff to `runs/<run>/lanes/<lane>-gates.diff`, aborts, puts the lane back to
  `passed`, and sends the diff path and the last 4 KiB of the log. The run line only holds merges whose gates passed.
  When every lane is `merged` or `declined`, the coordinator of a `running` run is told to call `open_run_pr`. In a
  `finished` run, `finish` pushes the run line after the commit with the VCS `publish` push, never forced, so the
  open PR shows the merge (ADR 0165). The message says so and never names `open_run_pr`. A failed push leaves the
  lane `merged`, and the message gives the error and says the PR does not show the merge.
  Each step keeps its name in memory, as the lane's `mergeStep`: `merging`, `gate <action>`, `committing`, `pushing`.
  The Runs panel chip reads `Merging: <step>`. `publish` also sets the coordinator's working label under source `runs`,
  `Merging lane "<name>": <step>` (no step yet after a restart), and clears it, and the step, in the publish that ends
  the merge (merged, conflict, red gate, cancel). A handover clears the old coordinator's label.
- **Run states.** `running`, `cancelled`, or `finished` (its PR opened).
- **Cancel.** `POST /api/runs/:id/cancel` (user token) ends a run. In one transaction the run becomes `cancelled`,
  every lane not `merged` becomes `cancelled`, the `runs.lane` and `runs.merge` jobs are cancelled, each lane's
  pipeline run stops through `PipelinesKey.stop`, and the pending deliveries of the coordinator and every lane agent
  are dropped (`AgentsKey.dropDeliveries`). Then a running gate action is cancelled, the coordinator and every lane
  agent stop (`AgentsKey.stop`, as archiving does), and any merge in the run worktree aborts, so the tree is clean.
  The `merge` and `finish` steps check the lane again after their git work and abort if it was cancelled meanwhile.
  It deletes nothing: lane workspaces, branches, the run line, and artifacts stay. It never merges, pushes, or opens
  a PR. A second cancel answers the run. The lane tools answer 409 `run_cancelled` for a cancelled run.
- **New coordinator** (ADR 0030, ADR 0157). `AgentsKey.afterWorkerChange` runs when a worker chat becomes a
  workspace's active one (a new chat, an older one activated, or one `activeWorker` creates). For a `running` or
  `finished` run whose workspace it is, that chat becomes the coordinator, and in one transaction it gets a handover
  first (the run name, line, and base; whether its PR is open; every lane with its wave, state, brief, and diff path;
  the open lane questions), then the old chat's pending
  deliveries, in order (`AgentsKey.moveDeliveries`). Job commits read the coordinator again, so a report never goes
  to the old chat. The launch hook gives the new chat the coordinator role, as it keys on the workspace.
- **Run PR** (ADR 0100, ADR 0130). `open_run_pr { title, body }` (bridge `POST /api/bridge/coordinator/pr`) needs
  every lane `merged` or `declined` and one `merged` (409 `run_not_finished` with the reason), no open request (409
  `run_pr_asked`), and a run that is not `finished` (409 `run_finished`). It files a `run-pr` approval with the
  title, body, base, and head (the run line); its reason names each declined lane and its reason, and the tool ends the turn. On approve, where the user may edit the
  title and body only (422 `approval_run_changed`), the runs module opens the PR through the opener the github-pr
  module sets with `RunsKey.setPrOpener`, the same path as the PR tab's publish, and the run becomes `finished`.
  Without that module the approve is 409 `pr_not_supported` and the approval stays open. The outcome or the
  decline note goes to the coordinator, as for every approval. No agent runs `gh`; nothing merges the PR but a
  human. Later merges into the finished run are pushed to that PR (see Merge).
- **Questions** (R7.5, R7.6, ADR 0008). `ask_coordinator` from a lane agent inserts a `runs_questions` row and
  delivers it to the coordinator in one transaction (403 `not_in_lane` outside a lane). The coordinator answers
  with `answer_lane` from the spec, or asks the user with `request_human_input` first; the answer is stored and
  delivered to the asking agent in one transaction (404 `question_not_found`, 409 `question_answered`). The bridge
  refuses `request_human_input` from a lane with 409 `ask_coordinator`. There is no lane-to-lane route.
- **Blocked lanes.** A lane's pipeline run that blocks tells the coordinator once per new error (section 8). The lane
  view carries `pipelineRunId` and the pipeline's `blocked` text; it is not a lane state. `PipelinesKey.onChange`
  republishes `runs:list` when a lane's pipeline changes, so the block shows and clears live.
- **Status** (`run_status`). `RunsKey.status` (bridge `GET /api/bridge/run-status/:id`) returns the run's state and
  each lane: id, name, wave, state, workspace name, the pipeline's current stage and round, `blocked`, the last
  message, and the diff path once it has one. Only an agent in the run workspace or in one of its lanes' may call
  it (403 `not_in_run`), read-only chats too. The coordinator and lane agents have the tool. The coordinator's rules
  say to check it before calling a lane lost, and after a user message that names a lane.
- Bridge routes: `POST /api/bridge/lanes`, `/lanes/revise`, `/lanes/merge`, `/coordinator/answers`, `/coordinator/pr` (not for
  read-only callers), `/coordinator/questions` (lane reviewers too), and `GET /run-status/:id`. The runs module
  checks who may call each.
- Routes: `GET /api/runs?projectId=`, `GET /api/runs/:id` (with lanes and open questions), `POST /api/runs`,
  `POST /api/runs/:id/cancel`. `RunsKey.create` does the same as `POST /api/runs` for other modules, with an
  optional coordinator model; kanban starts runs from cards with it (section 12). Topic `runs:list` sends
  `{ type: "runs", runs }` on subscribe and after every change. `RunsKey.onChange(listener)` runs after each of
  those publishes; a throw is logged and the other listeners still run.
- Web: a Runs page (`#/runs`, rail icon) with a start form and every run's state and lanes by wave, and a run panel
  on a run workspace (the same card) or a lane workspace (a link to its run). A blocked lane shows `Blocked`, the
  error, and Retry, which calls the pipeline's retry route. A running run's card has Cancel, with
  a confirm that names what stops. Home shows a `run-pr` approval with the head and base and an editable title and
  body.
- CLI: `pi-spore run start <project> <name> [--base <line>] [--gate <action>]...`, `run list [--project <id>]`,
  `run show <run>`, `run cancel <run>`.

## 10. Model routing

See [ADR 0009](decisions/0009-model-routing.md), [ADR 0010](decisions/0010-local-model-queue.md),
[ADR 0023](decisions/0023-model-tiers.md), [ADR 0024](decisions/0024-routing-thresholds.md),
[ADR 0141](decisions/0141-router-ladders.md), and [ADR 0144](decisions/0144-routing-calibration.md).

- `pi-extensions/router/` (package `@pi-spore/router`) registers the virtual model `spore/auto` with
  `pi.registerVirtualModel`. pi-spore agents load it with one more `-e` (section 2). Plain `pi` loads it with
  `pi -e <repo>/pi-extensions/router` or by adding the folder to Pi's `packages`.
- On every request the router loads the settings and checks each ladder entry and local target against Pi's catalog:
  the model must be in it and must take the entry's thinking level (`getSupportedThinkingLevels`). A local target
  missing from the catalog is allowed. A wrong setting ends the request with an error that names it, such as
  `router.ladders[2].rungs[1].thinking`. It does not fall back.
- Ladders (ADR 0141): `router.ladders` lists plans in order (default `claude`, `codex`, `openrouter`). Each plan has
  three rungs, cheapest first, and each rung has a model and a thinking level. The router sends the entry's level,
  never the level the user picked for `spore/auto`. Rung 1 tries the local target first. The router never routes to
  a model of tier `top` (Fable) or to `spore/auto`.
- On a session's first request (no router state yet, or a state from before ADR 0141):
  1. Estimate tokens at about 4 characters per token: the conversation so far (system prompt and brief) plus the
     size of every existing file the brief names.
  2. Ask the classifier (`router.classifier`, default `openrouter/~typesafe/jev-latest`) six choice questions about
     the brief in one call: bounded, explicit requirements, visual, straightforward, foundational (core, foundational,
     or novel work), and design (design judgment, planning, or feel).
  3. Pick the rung. Rung 3 if the good answer of visual, design, or foundational is below `router.heavyThreshold`,
     the estimate is above `router.large`, or the classifier failed. Else rung 1 if bounded, explicit, and
     straightforward reach `router.threshold` (`router.pressureThreshold` under usage pressure). Else rung 2.
     Explore (ADR 0144, 0173): when the only failed answer is "straightforward" or "visual" (not both), the
     estimate is not above `router.large`, the session is a pipeline worker stage
     (`PI_SPORE_STAGE_ROLE=worker`, so a stronger reviewer checks it), the local target can take the task, and a
     random draw is below `router.explore`, the task goes local anyway. The record has `explore: true`. Workspace
     slices reach it too, because the orchestrator sends them through the pipeline (ADR 0162).
  4. Pick the plan: the first ladder plan that is not full. A plan with no fresh numbers counts as having room; the
     reason says "usage unknown". If every plan is full, the route is `wait`: the request ends with an error that
     names the first reset, and no state is stored, so the next message routes again.
  5. Rung 1 goes local when the first local target is in the catalog, the estimate fits its budget (default 50% of
     its context), and the queue is short (below). Otherwise it goes to the plan's rung-1 cloud model.
  6. Store the choice (rung, plan, model, thinking level) as router state on the session branch. Later requests stay
     on it, to keep the prompt cache. Requests outside the agent loop (`direct`, such as compaction) go to the model
     that answered last, at its level.
- Escalation is the only move: on any rung below 3, a context overflow or the second failed request in a row moves
  the session up one rung, on the first plan with room. A `queue_wait_timeout` error (Strata busy, spike Q3) does not
  count as a failure. Rung 3 does not escalate.
- If the router fails itself in another way, it routes to the first ladder's rung 3, pins the session there, records
  `kind: "error"` with the message, and shows a warning.
- Every decision is appended to `~/.pi-spore/usage/routing.jsonl`: time, kind (`initial`, `escalation`, `error`),
  route (`local`, `cloud`, `wait`; old lines may say `spill`), rung, plan, model, thinking level, reasons, Jev's
  good-answer probabilities, the estimate and budget, `threshold` and `heavyThreshold`, `explore`, the plan windows it
  saw, and the session id, file, and folder. Inside pi-spore it also has the agent and workspace ids. The chat shows
  each decision as a notice (`spore/auto: rung 2 claude → <model> (high) (...)`), which is live only. A new `info`
  notice replaces earlier `info` notices, so one shows; `warning` and `error` notices stay, up to 5. A notice with
  the same level and text as one shown replaces it at the newest place, so a repeated warning shows once. The model
  picker names the model that answered last (`→ <model>` after `Auto (pi-spore router)`), read from the physical
  model Pi records on each assistant message, so it survives reloads and reconnects.
- Local targets are a list in settings: `{ model, thinking, contextWindow, budget, concurrency, healthUrl? }`.
  Default: Strata `strata/qwen3.8-flash-next-unsloth-ud-iq2_xs`, level `high`, 131072 tokens, budget 0.5,
  concurrency 1, health URL `http://127.0.0.1:8080/health`. A second local server is one more entry.
- Queue (ADR 0010, 0141): a session routed local takes a slot through a lock file,
  `$XDG_RUNTIME_DIR/pi-spore/<target>.<n>.lock`, one per slot up to `concurrency`. The file holds the pid; a lock of a
  dead process is taken over. A busy target makes the request wait, with a "Waiting for <model>" status and notice,
  and a wait file `<target>.wait.<pid>.lock` that other sessions count. When every slot is busy and
  `router.maxQueued` sessions already wait, a new rung-1 task goes to the plan's rung-1 cloud model instead. Wait
  files of dead processes do not count. In pi-spore the agents module forwards the status (key `pi-spore-router`) as
  the agent view's `routerStatus`, cleared when the run settles or the process exits. The workspace list and Home's
  running list show it (tone `warn`) while the agent is busy (R4.5). The slot is held for the agent run and freed on
  `agent_settled`, on session shutdown, and on escalation. The same files work in pi-spore and in plain `pi`.
  Without `XDG_RUNTIME_DIR` the router cannot lock, and rung 1 goes to the cloud model.
- Starting a local target: before the first local request of a run, the router emits `pi-spore:local-route` on
  `pi.events` with `{ provider, modelId, ctx, wait(promise) }`. The extension that runs the target starts it and passes
  its "ready" promise to `wait`; the router awaits it. The user's `strata-model.ts` does this for Strata. Then the
  router checks `healthUrl`. A failure frees the slot; a new task goes to the rung-1 cloud model, a pinned session
  escalates. The router never starts or stops a server itself.
- Usage pressure (R4.10): the router reads the plan snapshots (section 11a). If the chosen plan has a fresh weekly
  window above 75% or a 5-hour window at 100%, it lowers the rung-1 bar. It never lowers `heavyThreshold`, so the
  visual check never relaxes.
- Pipelines use the router through `tier = "route"`, the built-in default's implement stage (section 8, R4.9). A
  worker pinned to a cloud model under usage pressure gets the `pipeline-local-implementer` approval (section 8,
  R4.10).

### Router settings

In `~/.pi-spore/settings.json` (or `$PI_SPORE_HOME/settings.json`), read by the extension on each request. Built-in
defaults apply to every key left out. Unknown `router` keys and wrong values are an error that ends the request.

```json
{
  "router": {
    "classifier": "openrouter/~typesafe/jev-latest",
    "ladders": [
      { "plan": "claude", "rungs": [
        { "model": "claude-bridge/claude-haiku-5-5", "thinking": "high" },
        { "model": "claude-bridge/claude-sonnet-5-5", "thinking": "high" },
        { "model": "claude-bridge/claude-opus-5-5", "thinking": "high" } ] },
      { "plan": "codex", "rungs": [
        { "model": "openai/gpt-6-luna", "thinking": "xhigh" },
        { "model": "openai/gpt-6.1-sol", "thinking": "high" },
        { "model": "openai/gpt-6-astra", "thinking": "high" } ] },
      { "plan": "openrouter", "rungs": [
        { "model": "openrouter/openai/gpt-6-luna", "thinking": "xhigh" },
        { "model": "openrouter/deepseek/deepseek-v4.1-flash-1017", "thinking": "high" },
        { "model": "openrouter/openai/gpt-6.1-sol", "thinking": "high" } ] }
    ],
    "localTargets": [
      { "model": "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs", "thinking": "high", "contextWindow": 131072,
        "budget": 0.5, "concurrency": 1, "healthUrl": "http://127.0.0.1:8080/health" }
    ],
    "threshold": 0.7,
    "heavyThreshold": 0.7,
    "large": 100000,
    "maxQueued": 1,
    "explore": 0,
    "pressureThreshold": 0.55,
    "pressure": { "weekly": 0.75, "fiveHour": 1 },
    "usageMaxAgeMinutes": 60,
    "plans": { "claude-bridge": "claude", "anthropic": "claude", "openai": "codex", "openai-codex": "codex" }
  },
  "tiers": { "llama-cpp/qwen3.8-27b-m": "local" }
}
```

- `ladders` replaces the whole default list when set. A ladder's `plan` names its usage file
  (`~/.pi-spore/usage/<plan>.json`). OpenRouter sends no plan window, so its plan always has room.
- `router.cloud` and `router.spill` are gone (ADR 0141). Either key is an error that names `router.ladders`.
- The Settings page shows each top-level `router` key as `router.<name>`, and `tiers` as one row, with the value
  the router uses. The source is `global` when the file sets the key, else `default`; `pressure`, `plans`, and
  `tiers` merge with the defaults, so any value in the file makes them `global`. The projects module reads them
  with the router's `routerSettingEntries`, so the router's parser stays the only check. A bad router key answers
  422 `bad_settings` with the parser's message, which names the key and the file. These keys are read only from
  `settings.json`, never from `config.toml` (R17.3).
- `threshold` is the rung-1 bar, `heavyThreshold` the rung-3 bar for visual, design, and foundational, `large` the
  rung-3 token estimate, and `maxQueued` the most sessions that may wait for a busy local target.
- `explore` (0 to 1, default 0) is the chance of the explore route above. pi-spore never changes a bar by itself;
  the calibration report (section 11a) only suggests a `threshold`. The user sets it by hand, or with the confirmed
  button on the Usage page. Its outcomes come from pipeline runs: lanes, and
  workspace slices that the orchestrator starts with `start_pipeline` (ADR 0162).
- `plans` maps a provider to the subscription plan it draws on, for pipeline pressure checks (section 8). `tiers`
  entries are added to the built-in tier list, `local < light < medium < heavy < top` (ADR 0023, 0141).

## 11a. Usage module

See [ADR 0022](decisions/0022-usage-tracking.md).

- Plan windows (5-hour, weekly, reset times):
  - Claude: pi-claude-bridge turns Claude Code's `rate_limit_event` into `anthropic-ratelimit-unified-*` headers
    on Pi's `after_provider_response` event. The built-in `anthropic` provider sends the same headers. Utilization is
    0 to 1; resets are epoch seconds.
  - OpenAI Codex: `x-codex-*` headers or `codex.rate_limits` stream events on Pi's `openai-codex` provider
    ([spike Q11](spikes/q11-codex-plan-windows.md)). The user's `openai` login sends none.
- The usage tap ships in the router extension (section 10), so every Pi process that loads it counts, plain `pi`
  too. It reads headers on `after_provider_response` and Codex events on `provider_stream_event`, and merges them into
  `~/.pi-spore/usage/<plan>.json` with an atomic rename:
  `{ plan, status?, source, seenAt, windows: { "5h": { utilization, resetsAt?, seenAt }, "7d": ... } }`. Each window
  keeps its own `seenAt`, because one response may report only some windows. Malformed numbers are an error, not a
  guess.
- Headers arrive only when a request is made, so a snapshot can be old. A window is stale when its reset time has
  passed or it was seen longer ago than `router.usageMaxAgeMinutes` (default 60). Stale windows are shown as stale
  and the router ignores them (R18.5).
- Claude is passive (ADR 0022). Codex is polled (ADR 0153), because the `openai` login sends no headers. The `usage`
  module's job `usage.codex-poll` asks `GET https://chatgpt.com/backend-api/wham/usage` once a minute, started in
  `onStarted`. It reads the Codex CLI login from `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) read-only and
  never refreshes it. `readUsageEndpoint` (router) turns the body into `5h` and `7d` windows and `writeReading` merges
  them into `codex.json`. A failed poll sets a message that `GET /api/usage/plans` returns in `errors`
  (`Codex usage: ...`) and the job goes on. It also counts use from the Codex CLI, which the tap cannot see.
- The `usage` module (`modules/usage/`, not core, requires `projects`, `workspaces`, `pipelines`, `attention`, and
  `agents`) reads the router's files on each request through `@pi-spore/router`, so file formats have one
  definition. It owns one table, `usage_outcomes` (ADR 0144): on `PipelinesKey.afterRunEnded`, a run with a worker
  agent stores its state,
  the verdict of the last review of its first reviewer stage, its review rounds, and its fix passes. Retention
  deletes rows with the same cutoff as `routing.jsonl`.
  - `GET /api/usage/plans`: each plan's windows with age and staleness, warnings, the thresholds, and plan files that
    did not read. A warning is a fresh window that is full, a weekly window above `router.pressure.weekly`, or a
    5-hour window at or above `router.pressure.fiveHour` (R18.4).
  - `GET /api/usage/tokens`: token use per project, workspace, role, and model, summed from the `usage` of every
    assistant message in two folders (R18.2, R18.3). Both have the layout `<folder>/<name>/*.jsonl`:
    `~/.pi-spore/sessions/<workspace id>/`, and Pi's own `<agent dir>/sessions/<encoded folder>/` (the agent dir is
    `PI_CODING_AGENT_DIR` or `~/.pi/agent`), where a plain `pi` in a terminal writes. A row from a plain session has
    `external: true`, no workspace, and no role; its project is the registered project or workspace folder that holds
    the session's `cwd` (from its header), else the folder's own name. A pi-spore row gets its `role` from
    `AgentsKey.sessionRoles(workspaceId)`, which maps session files to the agent's role. A session whose agent row is
    gone has no role. Sums are cached per file by size and content hash (a file can change and keep its size and time). Models in the `local` tier show as
    free (R18.2). Lines that are not JSON are counted, not fatal. A forked session (a side chat) skips the entries
    copied from its parent, which are older than its header, so they count once.
  - `GET /api/usage/routing?limit=<1-500>`: the newest routing decisions (default 50), and how many lines did not
    parse.
  - `GET /api/usage/calibration`: the routing calibration report (ADR 0144). It joins each outcome to the newest
    `initial` decision of its worker agent before the run ended. A `local` decision passed when the verdict is
    `approve` and no `escalation` record has its session id. The report has Jev's answers per question in ten
    buckets (answers, local outcomes, passed; old lines lack `foundational` and `design`), and for bars 0.1 to 0.9
    how many decisions would have gone local and how many of those passed. A decision clears a bar when its bounded,
    explicit, and straightforward answers reach it and its visual, design, and foundational answers reach
    `heavyThreshold` (ADR 0141). A share under 20 local outcomes has `enough: false`. `suggestedBar` is the lowest bar
    with 20 local outcomes and 90% passed. It is only a suggestion. `rungs` counts decisions, outcomes, and passes per
    rung and place (`local` or the plan), for every decision with a rung. It also returns `explore`.
  - `PATCH /api/usage/router` with `{ threshold?: number, explore?: 0 }`: sets `router.threshold` or removes
    `router.explore` in `settings.json` (ADR 0144). Every other key stays. The router's own parser checks the new
    file before the write; a bad file answers 422 `bad_settings` and is not changed. The write goes to a temp file,
    then a rename, so the router never reads half a file. A missing file counts as `{}`.
  - Wrong router settings answer 422 `bad_settings`.
- The Usage page (`#/usage`, rail icon) shows the plan windows with bars, reset times, age, and a stale chip; the
  warnings at the top; the token table, grouped by workspace or by role and filtered by role; the routing decisions
  with their rung, plan, model, thinking level, and reasons (both tables show 10 rows a page, with Previous and
  Next when there are more; the browser pages the rows it already has, and the "by role" view sums all rows
  before it pages); and the routing calibration (the bars table with "now"
  and "suggested" chips, the per-rung table, and the buckets). Under the report, "Apply suggested bar" shows when
  the suggested bar differs from the bar now, and "Turn off explore" shows when `explore` is above 0. Each opens a
  confirm dialog (ADR 0029) and sends the request only on yes. It loads on open and on Refresh.
- CLI: `pi-spore usage calibration [--json]` prints the same report.

## 11b. Home and questions (attention module)

See [ADR 0008](decisions/0008-questions-up-the-chain.md). Requirements R3.5, R5.6, R15.

- The `attention` module (core, requires `projects`, `workspaces`, `agents`) owns questions (`attention_questions`:
  agent, workspace, question, choices, recommended, steps, artifacts, state `open`, `answered`, or `closed`, answer,
  times).
- A question may link 1 to 6 **artifacts** `{ scope, path, label? }` (ADR 0200), the files the user should read
  first. The bridge route checks each exists (`ArtifactsKey.list`); a missing one is 400 `artifact_not_found` with
  the path, and nothing is filed. The stored question adds `ownerId` to each (the workspace id, or its project id).
  The column is NULL for none, so old rows load; answered and closed questions keep it.
- A question has 1 to 6 **steps** (`QuestionStep`). Each has a Markdown `prompt` and a `type`: `text`, `select`,
  `multiselect`, or `confirm`. `select` and `multiselect` have 2 to 8 `options` (`label`, Markdown `description`,
  Markdown `preview` for a code example or a text diagram), an optional `recommended` index, and `allowOther` (the
  user may write their own answer). `confirm` may recommend `true` or `false`. The agent files either `steps` or the
  old form `question`, `choices`, `recommended`; both together, or neither, is 400 `bad_question`. Duplicate labels
  in a step are 400 `bad_question`. The old form is stored with `steps` NULL and reads as one `select` step with
  `allowOther` (or one `text` step without choices), so old rows read the same way. `question` always holds the
  first prompt, for lists and notifications.
- `recommended` is advice only: Home shows a "Recommended" chip and never picks for the user, and `pi-spore inbox`
  marks it `(recommended)`. An index without choices, or past the last option, is 400 `bad_recommended`. A question
  closes when
  its orchestrator chat stops being the active one; answering it then is 409 `question_closed` (ADR 0033). The bridge module files them
  through `QuestionsKey`.
- `POST /api/attention/questions/:id/answer` takes `{ answers }`, one `StepAnswer` per step in order (`text`,
  `select` with a `label` or an `other` text, `multiselect` with `labels` and an optional `other`, `confirm` with
  `yes`), or the old `{ answer }` free text for a one-step question. A wrong count, a wrong type, an unknown label, or
  `other` on a step without `allowOther` is 400 `bad_answer` that names the step. It stores the answer and queues it
  for the agent through `AgentsKey.deliver`, in one transaction. A second answer is 409 `question_answered`. The
  agent gets one message that names the question. For one step it has the question text and the answer; for more
  steps it lists each step's prompt (first line) and its answer, in order.
- `GET /api/attention/inbox` and topic `attention:inbox` give the inbox. The topic sends the whole inbox on subscribe
  and after every change (at most once per tick). It has:
  - Every item names its chat (`chat`: id, title, kind, active) and links to `#/workspaces/<id>/chats/<chat>`.
  - `items`, newest first: open questions; open extension dialogs of running agents; failed agents with their error;
    agents whose last run ended and that wait for the user (`finished`), unless they have an open question or a
    running helper. Pipeline stage agents are never `finished`: their pipeline reads the report and moves on. `notice` items
    come from other modules' sources (below). A notice has no chat: it has `source`, `id`, `title`, optional `detail`, and
    an `href` to the module's page.
  - `running`: agents that are busy, starting, or waiting for a slot, and idle agents with a running helper
    (`status: "helpers"`). When the helper ends, an idle agent that waits for the user is `finished` again. Home shows
    one row per workspace, so this list has at most one item each: `chat` is the chat that row stands for, and
    `others` counts the chats behind it (below).
- The agents module tracks what Home needs (`AgentsKey.attention()`): when each agent entered its status, when each
  dialog opened, and `waiting_since` on `agents_agents`. `waiting_since` is set when a run settles without an abort,
  and cleared when the user sends a message, opens the chat, the chat page sees the run end while it is visible, or
  the user dismisses it (`POST /api/agents/:id/seen`). Statuses and dialogs live in memory; after a restart every
  agent is stopped. Each entry also has `activity`, one line of at most 80 characters about what the agent did last,
  built from its live chat by `chatActivity` in `packages/shared/src/chat.ts`: a tool that runs now ("Running bash:
  npm test"), else the newest assistant message's last tool call ("Ran read: <path>") or the first line of its text
  ("Replied: ..."), and "Asked a question" while a dialog is open. Only bash's command and the path of read, edit,
  and write show; never a tool's result. The chat page's working indicator uses the same `toolActivity` text and counts
  from `statusSince` on the agent view, when the chat reached its status; a second `agent_start` in one run (a retry or
  a compaction) does not restart the count. The agents module fires `onChange(id, "activity")` only when a tool
  starts or a message ends, never per streamed token, and that change does not republish `agents:list`.
- The Home page (`#/`, attention web module) shows the items as cards: a question one step at a time (`QuestionCard`
  in `question-card.tsx`): "Step 2 of 4", Back, Next, and Send answer on the last step, which sends every answer in
  one request. Nothing is sent before that. Answers are kept while the user moves, and in `sessionStorage`
  (`pi-spore:question:<id>`) across a reload. Option rows show the label, the description, and the chip; the
  selected option's preview shows beside the list on a wide screen and under it on a narrow one. Arrow keys move,
  Enter picks and goes Next, Escape goes Back, Ctrl+Enter goes Next from a text box. A question's artifacts show as
  **Read <label>** buttons above the prompt on every step (label default: the file name). The artifacts web module
  draws them through `AttentionWeb.setArtifactLink`; without it the card shows the paths as text (ADR 0200). Prompts, descriptions, and
  previews render with `Markdown` from `@pi-spore/ui` (react-markdown with remark-gfm; no raw HTML; links open in
  a new tab; images show as links, ADR 0061); the same dialog card as the chat (from the agents web interface `AgentsWebKey`); a failure with its error;
  a finished agent with Open chat and Dismiss. The inbox also has `interrupted`: jobs a restart cut off (section
  6), read through `host.jobs` and shown as "Interrupted work" with Retry and Cancel. Running work is a short list
  below, one row per workspace. A row shows a stage chat that works, then a stage chat that waits for a worker slot,
  then the workspace's active worker chat, and the newest of the rest; "+N more" counts the workspace's other chats
  that work, and a worker chat that only waits for its stage (status `pipeline`) is not one of them. A workspace with
  a working label (section 2) and no running item gets one: status `pipeline`, the label as its detail, on its
  active worker chat, else its newest chat. A workspace with no chat at all gets no row; its run's coordinator row
  still shows the run. Under the chat
  name, a row shows its chat's `activity` as a muted line, cut to the row's width, with the full text as its title;
  on a phone that line takes the whole row. The Home rail
  icon shows the count of items and interrupted jobs through `RailItem.useBadge`.
- The chat page shows its own open questions and approvals above the composer, so the user need not go to Home. The
  agents web interface has `AgentsWebKey.addChatPanel(id, component)`: the chat page renders each added component,
  given the chat's id, above the composer of an active chat. With none added, the chat looks as before. The attention
  web module adds one. It reads the same `attention:inbox` store as Home, keeps the items of this chat with
  `chatAsks(inbox, chatId)` (open questions and approvals, in inbox order), and renders them with Home's
  `QuestionCard` and approval views. An answer is the same call from both places, and the inbox update removes the
  item from both. Failures, finished work, and dialogs stay as they were (dialogs show in the chat already). An older
  worker chat, a side chat, or a workspace that is not active shows no panel; their questions are closed (ADR 0033).
- The workspace list shows "Waiting for your answer" (tone `warn`) for a workspace whose active worker chat waits
  for the user. One rule, `waitShows(status, wait)` in the agents module's `status.ts`, decides when a wait shows,
  for the list and the agent graph: an open dialog always, also while the chat is busy, since the dialog blocks it;
  an open question or approval only while the chat is idle or stopped. A failed chat stays failed. The agents web
  interface has `AgentsWebKey.setUserWaits(hook)`: a React hook that returns, per chat id, why that chat waits for
  the user (`question`, `approval`, or `dialog`). The attention web module sets it from the same `attention:inbox`
  store, with `chatWaits(inbox)`. `AgentsWebKey.useUserWaits` calls the hook set now, so the agent graph reads the
  same waits with no second subscription. With no hook set, the list looks as before.
- **Home sources** (ADR 0155): a module adds items to Home with `HomeItemsKey.register(name, source)`, where
  `source()` returns the current `HomeNotice[]` (`id` stable and unique within the source, `at`, `title`, `detail?`,
  `href`). Attention keeps no state for them. It reads every source each time it builds the inbox, so an item shows
  while its condition holds and goes when it clears. `HomeItemsKey.changed()` builds and pushes the inbox on the next
  tick, so a new item reaches the topic and the desktop notification path; a module calls it where its condition
  changes. Only the newest inbox build publishes, so a slow source cannot bring back an item that has cleared. A source that throws is logged and skipped. Home shows a notice as a card with an Open link. Registered
  sources:
  - `github-pr`: a PR whose watch is `waiting` (`#/workspaces/<id>`), in an active workspace. It calls `changed()` on
    every write of the PR row.
  - `kanban`: a card past due or due today that is not in Done (`#/board/<card id>`). It calls `changed()` on every
    board change. "Today" is the server's local day, as on the board (`localDay`, `dueState`); a card that turns
    overdue at midnight shows on the next inbox build.
  - `usage`: each usage warning (R18.4, `#/usage`). The router writes the plan files from any Pi process, so the
    module watches `~/.pi-spore/usage/` and calls `changed()` when a plan file changes.
  The Usage page, the PR tab, and the board keep their own displays.
- Desktop notifications (R15.2): a button asks for permission; the page never asks on load. While the page is open
  but not focused, each new item shows a notification, except one whose chat is on screen while the page is
  visible (see Toasts). Items already there when the page loads do not. Phone browsers show notifications only from
  a service worker, so this button hides on phones (ADR 0159); phones use Web Push (below). A notification that
  fails to show logs one warning and the inbox goes on. The browser's permission is the only switch; pi-spore has
  no notification setting (ADR 0167).
- **Phone push** (ADR 0196): on a phone that runs the app from the Home Screen (`display-mode: standalone`) and has
  `serviceWorker`, `PushManager`, and `Notification`, Home shows "Turn on notifications" (`PhonePushButton` in
  `phone-push.tsx`). The tap asks for permission first, then registers `/sw.js`, subscribes with the VAPID public
  key (`GET /api/attention/push/key`), and sends the subscription (`POST /api/attention/push/subscriptions`, an
  upsert by endpoint). Then it shows "Notifications are on" and "Turn off" (unsubscribe, then
  `DELETE /api/attention/push/subscriptions`). On load a phone with a subscription sends it again.
  - The server keeps subscriptions in `attention_push_subscriptions` (endpoint, keys, VAPID subject
    `https://<Host it subscribed through>`, user agent label, created at). The VAPID key pair is in
    `~/.pi-spore/vapid.json`, mode 0600, made on first start.
  - When the server starts it builds the inbox once and pushes nothing for it. After that, each new chat item
    (question, approval, dialog, failed, finished; never a notice) sends one push to each subscription through
    `web-push` (TTL one day, urgency high), unless a desktop page has focus. The payload is `PushPayload`: the
    `notification(item)` title and body, each cut to 200 characters, the item's link, its key as the tag, and the
    Home count as the badge. `createAttentionModule({ sendPush })` lets tests pass a fake sender.
  - A desktop page (the toast rule) reports focus with `POST /api/attention/push/focus { page, focused }` at load,
    on focus, every 30 seconds while focused, and on blur. The server keeps each report in memory for 60 seconds.
  - A 404 or 410 from the push service deletes that subscription. A failed push is logged by subscription id and
    status, never by endpoint.
  - `sw.js`: `push` shows the notification and sets the app badge best effort; `notificationclick` focuses an open
    window and navigates it to the link, or opens one. Home clears the app badge when it opens.
- Toasts (R15.2): while the page has focus, each new item shows an in-page toast instead (`showToast` and
  `Toaster` in `packages/ui`, mounted once in `App.tsx`). One item gives a toast or a notification, never both;
  `notifyItem` in the attention web module makes that choice. Toasts show only on desktop screens
  (`(hover: hover) and (pointer: fine)`). While the page is visible, an item whose chat is the one on screen makes
  no signal at all, because that chat shows its own asks (`shownChat` in the agents web contract). A toast has the
  item's title and body, an Open link to the same place as on Home, and a close button. The body shows at most 4
  lines (`line-clamp-4`, CSS only, so screen readers read all of it); the full text stays on Home. It closes after
  8 seconds, and hover pauses that. At most 3 show at once.
- **Approvals** (ADR 0100): decision gates in `attention_approvals` (kind, asking agent, workspace, title, reason,
  subject as JSON, state `open`, `approved`, or `declined`, outcome, times). The module that owns a gate registers
  its kind through `ApprovalsKey.register({ kind, subject, approve, decided? })` and files approvals with
  `ApprovalsKey.file(caller, ...)`; the kind's TypeBox schema checks the subject both times. Open approvals are Home
  items (`kind: "approval"`); an agent with an open approval is not also shown as finished.
  - `GET /api/attention/approvals?state=` lists them, newest first; `GET /api/attention/approvals/:id` reads one.
  - `POST /api/attention/approvals/:id/approve` `{ subject? }` runs the kind's `approve` with the filed subject or a
    changed one, then stores the decision and delivers the outcome to the asking agent in one transaction. A throw
    leaves the approval open and answers with the error. A second approve while one runs is 409
    `approval_deciding`; a decided one is 409 `approval_decided`; a kind no enabled module handles is 409
    `approval_kind_unknown`.
  - `POST /api/attention/approvals/:id/decline` `{ note? }` stores the decline and delivers it with the note.
  - A kind's optional `decided(subject, approval, approved)` runs inside the transaction that stores either
    decision; a throw rolls it back and leaves the approval open. Pipelines use it for `pipeline-round-limit` and
    `pipeline-local-implementer`; runs for `lane-model` and `run-pr`; github-pr for `workspace-pr`.
  - Kinds now: `card-start` (kanban), `lane-model` and `run-pr` (runs, section 9), `workspace-pr` (github-pr,
    section 11e), `pipeline-round-limit` and `pipeline-local-implementer` (pipelines). A `pipeline-round-limit` subject is `{ runId, stage, action }` with
    `action` `fix` or `accept` (section 8). A `run-pr` subject is `{ runId, title, body, base, head }`; approve
    may change the title and body, and opens the run's PR through the opener the github-pr module sets (section 11e).
    A `workspace-pr` subject is `{ workspaceId, title, body, base }`; approve may change the title and body.
  - These routes take only the user's token, and no bridge route decides an approval, so an agent cannot approve
    its own request.
  - Home shows an approval with the view its kind's web module adds through `AttentionWebKey.addApprovalView`, or a
    plain one (title, reason, approve, decline with a note).
- The CLI reads the same route: `pi-spore inbox list` prints each item and each running workspace row with an id,
  its kind (`question`, `approval`, `dialog`, `failed`, `finished`, `running`, `notice`), age,
  `project / workspace`, and the chat link. `pi-spore inbox show <id>` prints one in full: a question's text and choices (a question with steps: each
  step with its options, and that it is answered on Home), an approval's gate, title,
  reason, and subject, a dialog's prompt, a failure's error. Ids are `<kind>:<id>` (a dialog is
  `dialog:<agent>:<dialog>`; `failed`, `finished`, and `running` use the agent id). A notice is
  `notice:<source>:<id>`; it has no workspace or chat, so its place column is the source name, its link is its
  `href`, and `show` prints its source, title, and detail. Interrupted jobs are not listed; `pi-spore jobs` shows
  them.

## 11c. Terminals

See [ADR 0050](decisions/0050-terminals.md). Requirements R13.

- The `terminals` module (not core, requires `projects` and `workspaces`) runs each terminal as a `node-pty` PTY:
  the user's `$SHELL`, the workspace folder as cwd, and the env of actions (`PI_SPORE_WORKSPACE_ID`,
  `PI_SPORE_WORKSPACE_PATH`, `PI_SPORE_PROJECT_ROOT`) plus `TERM=xterm-256color` and `COLORTERM=truecolor`, without
  `ORCA_*` and `HERDR_*`. No `$SHELL` answers 500 `shell_not_set`.
- Terminals live in memory, with no table. Each keeps the last 1 MiB of output (characters, cut at a line start) as
  scrollback. A shell that exits stays listed as `exited` with its code until the user closes it.
- At most 8 open at once, across workspaces (`terminals.maxOpen`); more answers 409 `terminal_limit`. Both limits
  are module options until the settings module lands.
- Closing sends SIGHUP, then SIGKILL after 5 s, and closes the terminal's sockets. Parking or archiving a workspace
  closes its terminals first (`beforeLeaveActive`). Server exit sends SIGHUP to every shell.
- Input and output never reach a log.

| Route | Does |
|---|---|
| `GET /api/terminals/workspaces/:id` | The workspace's terminals and the limit. |
| `POST /api/terminals/workspaces/:id` `{ cols, rows, title? }` | Opens a terminal (active workspaces only). Default title `Terminal <n>`. |
| `DELETE /api/terminals/:id` | Closes it; answers when the shell has exited. |
| `WS /api/terminals/:id/socket` | The terminal's socket. 404 for an unknown terminal. |

- Socket messages (TypeBox schemas in `@pi-spore/shared`): the browser sends `{ type: "input", data }` (up to 8192
  characters; the page splits longer pastes), `{ type: "resize", cols, rows }`, `{ type: "ack", chars }`, and
  `{ type: "visibility", visible }`. The server sends `snapshot` first (the scrollback), then `output`, `exit` once
  with `exitCode` or `signal`, and `error` for a bad message.
- Flow control: the page acks output in steps of 5,000 characters, after xterm has drawn it. The server counts each
  socket's unacked characters, the snapshot included. It pauses the PTY when a socket is more than 100,000 behind,
  and resumes it when every socket is below 10,000 (`flowControl` module option). A paused PTY makes the program
  wait, as in a real terminal. A hidden page sends `visibility: false`: it then gets no output and counts as 0
  behind, so it never holds the shell back. When it is shown again, it gets a fresh snapshot. A page that stops
  acking without closing holds the shell until the socket heartbeat drops it.
- The web module adds a Terminals tab to the workspace's right column (`WorkspaceView.addTab`, `wide`), with a tab
  per terminal, new and close buttons, and xterm.js with the fit addon. Colors come from the theme's role tokens and
  change with the theme menu. A font button sets the terminal font for this browser (`localStorage`); the font
  list is that font, JetBrains Mono, then `Symbols Nerd Font Mono` for prompt icons. A name with characters other
  than letters, digits, spaces, `.`, `_`, and `-` is refused, and a font the browser does not have shows a
  warning. When a socket drops, the page asks the server whether the terminal still exists and
  reconnects, or drops it from the list.
- On a phone the Terminals tab opens in the workspace sheet as it is (ADR 0159). The phone keyboard has no Esc,
  Ctrl, or arrow keys, and Android keyboards may double text in xterm.js, so a phone terminal suits reading and
  short commands.

## 11d. Changes

See [ADR 0090](decisions/0090-changes-and-pull-requests.md) and [ADR 0186](decisions/0186-changed-file-content.md).
Requirements R8.

- The `changes` module (not core, requires `projects`, `workspaces`, `agents`) reads a workspace's changes through
  its provider's `changes` capability (section 7). Projects without it (folders) answer 422 `not_supported`; a
  workspace whose folder is gone answers 409 `folder_missing`.
- The base for `line` is the workspace's recorded base, else the provider's default base; without either, 409
  `no_base`.
- Limits (module options): 1000 files in a list, 200 files with hunks in a diff without `path`, and 3000 lines or
  512 KiB per file. A larger or binary file has a `note` (`too_large`, `binary`) and no hunks.
- One side of a changed file comes from the optional `ChangeOps.content` (ADR 0186), at most 20 MiB (module option
  `maxContentBytes`). Git reads the new side of `uncommitted` from the working tree with `readFileInside`, and every
  other side with `git cat-file` on `<rev>:<path>`, through `exec` with `encoding: "buffer"`.
- Diff-line comments (R8.3) live in `changes_comments` (workspace, path, side `old` or `new`, line, the line's
  code, body, created, sent). "Send to agent" writes one delivery to the workspace's active orchestrator chat
  (`AgentsKey.deliver`) and marks the comments sent in the same transaction. Sent comments leave the open list. No
  orchestrator chat yet is 409 `no_worker_chat`. The message lists each comment with its file, line, quoted code, and text.
- A comment can also be staged (`staged` column): the user adds open comments to the composer of the workspace's active
  orchestrator chat as a batch. The `changes` module adds a prompt hook (`Agents.addPromptHook`). When the user sends a
  message in that chat, `POST /api/agents/:id/prompt` runs the hooks inside one transaction. A hook that returns text
  makes the route queue the message and that text as one durable delivery (`queued`), and the hook marks its comments
  sent in the same transaction, so a crash neither loses nor repeats them. The message text comes first, then the
  comments in the format above. The delivery keeps the prompt's images and its `whileBusy` choice (default steer) in
  its `options` column, which is cleared once Pi accepts the message. Other deliveries have no options: a follow-up
  with no images.
- Topic `changes:<workspace id>` sends the open comments on subscribe and after each change
  (`{ type: "comments" }`), and `{ type: "stale" }` when an orchestrator chat of the workspace ends a run, so an open tab
  reloads.

| Route | Does |
|---|---|
| `GET /api/changes/workspaces/:id` | Scopes, the initial scope for the tab, base, and the records since the base (100), or the last 50 records without one. `initialScope`: the first of `uncommitted`, `staged`, `line` with a changed file, else `uncommitted`. A scope whose list fails is skipped. |
| `GET /api/changes/workspaces/:id/files?scope=&record=` | Changed files with status and counts. `scope`: `uncommitted` (default), `staged`, `line`, `record` (needs `record=<id>`). |
| `GET /api/changes/workspaces/:id/diff?scope=&record=&path=` | Hunks of one changed file, or of every file up to the limit; `truncated` says it cut. A path without changes is 404 `file_not_changed`. |
| `GET /api/changes/workspaces/:id/content?scope=&record=&path=&side=old\|new` | One side of a changed file. An image extension (PNG, JPEG, WebP, GIF) answers that type only when the bytes match, else 415 `not_an_image`. A text file answers `text/plain; charset=utf-8`. Another binary file is 415 `not_supported`. A missing side is 404 `side_missing`; too big is 413 `file_too_large`. Every answer has `nosniff`, `default-src 'none'; sandbox`, and `no-store`. |
| `GET /api/changes/workspaces/:id/comments` | Open comments. |
| `POST /api/changes/workspaces/:id/comments` `{ path, side, line, code, body }` | Adds a comment. |
| `POST /api/changes/workspaces/:id/comments/stage` `{ staged, ids? }` | Stages open comments for the composer, or drops them from the batch (`staged: false`). No `ids` means every open comment. A dropped comment stays open. Answers the open comments. |
| `DELETE /api/changes/comments/:id` | Deletes an open comment; a sent one is 409 `comment_sent`. |
| `POST /api/changes/workspaces/:id/comments/send` | Sends every open comment to the worker as one message ("Send now"), staged or not. |

CLI: `pi-spore ws diff <workspace> [--staged | --commits | --commit <id>]` prints each file's status, path, and
counts, then its hunks in unified form.

- The web module adds a Changes tab (`WorkspaceView.addTab`, `wide`, before Terminals): a scope select
  (Uncommitted, Staged, "Branch since <base>", One commit with a commit select), the changed files with a status
  chip (A, M, D, R), a comment count, and `+`/`-` counts, then the selected file's diff. Unified or split view (a
  browser choice). Code colors come from lowlight (highlight.js grammars, `common` set), mapped to role tokens, so
  they follow the theme; each side of a hunk is colored as one block. A changed image shows its picture: the new
  side when added, the old side when deleted, else both sides with their sizes, side by side or stacked when narrow.
  SVG keeps its text diff. Other binary files and large files show a note. A Markdown file (`.md`, `.markdown`) can
  be shown rendered instead of as a diff, read from the content route; the choice is a browser flag
  (`pi-spore.changes.rendered`) and comments stay on the diff.
- Each diff line has a comment button (shown on hover and keyboard focus). Comments show under their line; the
  bar at the bottom lists them with Add to composer and Send now. The tab reloads on Refresh, on a scope change, and on the
  `stale` event. The tab opens on the summary's `initialScope`, once per open: a refresh, a `stale` event, or the
  user's own pick does not move it. If the summary fails, the tab opens on Uncommitted.
- Large view (not on a phone) moves the whole tab into a full-size `ContentDialog` (`size: "full"`), with the
  file list left of the diff. The tab keeps the state and renders the view in one place only, so there is one
  `changes:<id>` subscription. While the dialog is open, the tab shows a note with a button that closes it.
  Escape in a field does not close the dialog, so a comment form can use Escape to cancel.
- The module adds a chat panel (`AgentsWeb.addChatPanel`) above the composer of an orchestrator chat. It shows the
  staged comments with a count, Drop on each, and Drop all. It follows the `changes:<workspace id>` topic. The panel
  and the Changes tab each also load the open comments when they mount. A newer event wins over a late load.

## 11e. Pull requests

See [ADR 0090](decisions/0090-changes-and-pull-requests.md) and [ADR 0142](decisions/0142-merge-button.md).
Requirements R9.

- The `github-pr` module (not core, requires `projects`, `workspaces`, `agents`, `attention`, `kanban`, `runs`,
  `bridge`) talks to GitHub only
  through `gh`, run with `execFile`, `GH_PROMPT_DISABLED=1`, and `--json` where gh has it. Output is checked with
  TypeBox; a value it does not know (a new check conclusion) is a 422 `gh_failed`, not a guess.
- The only gh commands it runs: `gh pr view <number|branch> --json ...`, `gh pr create --base= --head= --title=
  --body= [--draft]` (the `=` form keeps a title starting with `-` a value), `gh run view --job <id>
  --log-failed`, `gh api --method=GET --paginate --slurp` for the PR's comments, reviews, and line comments, and
  `gh pr merge <number> --merge --match-head-commit <sha>` from the merge route and the merge-when-ready watch
  only (ADR 0164). It never closes, enables
  auto-merge, deletes a branch, merges with `--admin`, or force-pushes (R9.3). The tests fail on any other gh
  command.
- Merge (ADR 0142), `confirm: true` and the head the user saw: reads the PR fresh and refuses with 409
  `pr_not_mergeable` and the reason when the workspace is not active, or the PR is not open, is a draft, is not
  known to be free of conflicts, has a check that failed, was cancelled, or still runs, or waits for a review.
  A head other than the one the user saw is 409 `pr_changed`. The same reason is the status's `mergeBlocked`, so
  the tab shows why the button is off. After the merge it reads the PR once, as a refresh does, so the merged state
  moves the card to Done and ends the watch; the route does not move the card. It logs one line: workspace and
  number. Only the user's token reaches it (ADR 0032).
- Publish (`confirm: true` required): pushes the branch through the provider's `publish` (section 7), opens the
  PR, stores it, turns the watch on, and moves the workspace's card to Review (`CardsKey.workChanged`). The form
  starts with the workspace name as title, the card's body as body, and the workspace's base. A base like
  `origin/main` loses its remote name.
- `PullRequestsKey.open(workspaceId, { title, body, base, draft? })` gives other modules the same path as Publish,
  with the same errors. The module also sets the same function as the runs module's PR opener with `RunsKey.setPrOpener`, so the runs
  module opens a run's PR when the user approves a `run-pr` approval (section 9) and does not depend on this module
  (kanban requires runs, and this module requires kanban).
- Workspace PR by approval (ADR 0163). The module sets the bridge's requester with `BridgeKey.setPrRequester`, so
  the bridge does not depend on it. `open_pr` (bridge `POST /api/bridge/workspace/pr`, not for read-only callers)
  refuses, before it files anything, a workspace that cannot be published or has no base (422 `not_supported`), an
  open PR (409 `pr_exists`), and an open request (409 `workspace_pr_asked`, naming it). Otherwise it files a
  `workspace-pr` approval with the base the tab shows (the workspace's base, else the project's default) and
  records it in `github_pr_asks`. On approve, where the user may edit only the title and body (422
  `approval_workspace_changed`), it opens the PR through the Publish path. `decided` deletes the ask row. Nothing is
  pushed before approve; decline pushes nothing. Without this module the route answers 422 `not_supported`.
- Merge when checks pass (ADR 0164). The user may approve a `workspace-pr` approval with `mergeWhenReady: true`
  ("Open and merge when checks pass"); the filed subject never has it. The PR row stores it (`merge_when_ready`).
  For such a PR, each poll reads the row again after it reads GitHub and, while the choice and the watch are on and
  `mergeBlocked` finds nothing, runs the Merge route's command with the head it just read, logs one line, and reads
  the PR again, so the merged state ends the watch and moves the card. A refused merge stores gh's message, counts
  no try, and backs off as a failed read does. Conflicts with the base go to the chat once per head (`conflict_head`),
  also while checks run, in the same message and run of tries as failed checks. When the run of 3 tries ends, the
  choice turns off and the waiting message names the PR and the reason. `DELETE .../merge-when-ready`, Stop
  watching, and a merged or closed PR turn it off; only an approval turns it on.
- A PR opened outside pi-spore for the workspace's branch (an agent's `gh pr create`) is found and shown, with the
  watch off. `gh pr view <branch>` looks at open, merged, and closed PRs: the newest open one, else the newest.
  pi-spore looks:
  - on `GET ...?refresh=1`;
  - when a chat of the workspace ends a run (its status leaves `busy`);
  - in one `github-pr.discover` job (key `all`, one `look` step) at server start, then every 5 min (module option),
    over every active workspace.
  A look skips a workspace that is not active, has no folder or own branch, cannot be published, or has no card
  outside Done. Without a stored PR it finds one by branch. A stored open PR with the watch off is read again, so
  it is followed to merged; the watch job follows a watched one. A found PR never turns the watch on. A gh failure
  (no GitHub remote, no login) is logged once per workspace, in one line, and the look goes on.
- Tables: `github_pr_prs` (one per workspace: number, the last view as JSON, watch state, tries, the head whose
  failures were sent, the last clean head, message, poll times, the merge-when-ready choice, the head whose
  conflicts were sent, why an archive after the merge did not happen), `github_pr_sent` (bot comments already sent), and
  `github_pr_tries` (each automatic message, for the tab), and `github_pr_asks` (the open `workspace-pr` approval
  of a workspace).
- Watch (R9.2), a `github-pr.watch` job per watched PR (section 6), keyed by the workspace, with one `poll` step.
  Each poll's writes (the view, the delivery, the sent marks, the try, the next poll time) commit with its
  checkpoint, so a restart resumes at the saved next poll time and never sends twice. Parking or archiving
  cancels the job; resuming starts a new one. Only the job sends; a refresh or a push only stores the view:
  - Each poll reads the PR. 30 s after a change (head, checks, mergeability), doubling to 5 min while nothing
    changes.
  - When no check on the head is pending, it reads the bot comments. If a check failed on a head not handled yet,
    or a bot left comments not sent yet, it sends one message to the active orchestrator chat (`AgentsKey.deliver`):
    each failed check with its link and the last 80 lines (8 KiB) of its failed log (ANSI codes removed, at most 5
    logs), then the bot comments with file and line, then "commit and push again; do not force-push; do not merge".
    The delivery, the sent marks, and the try count commit in one transaction.
  - A bot is an account GitHub types `Bot` (Q14: their comments go to the worker; people's do not).
  - At most 3 tries in a row (module option). A head with every check passed and nothing to send ends the run. After
    3 tries, or with no orchestrator chat, the watch is `waiting` with a message, and sends nothing until the user resumes
    (`watch on`), which starts a new run and sends the current failures again.
  - A merged PR moves the card to Done; a merged or closed PR ends the watch (`done`). A PR first seen merged
    moves the card to Review (`PR #n opened`), then Done (`PR #n merged`), unless a card of the workspace is in
    Done already. A closed unmerged PR moves nothing.
- Auto-archive (ADR 0197). When a PR becomes merged, wherever that was seen, the module starts a
  `github-pr.auto-archive` job keyed by the workspace, in the same commit. Its one `archive` step does nothing when
  the workspace is not active or parked, `WorkspacesKey.archiveOnMerge` is false, or the stored PR is not merged.
  A chat that is busy, starting, or waiting, a chat with helpers running, or a workspace working label stops it.
  Otherwise it calls `WorkspacesKey.archive(id, { force: false })` and logs one line. A stop or a refusal stores
  the reason in `archive_message`; Home shows `PR #<n> merged; archive <workspace> by hand` until the workspace is
  archived. It never retries. A status read that fails while `WorkspacesKey.archiving()` names the workspace, or
  after its folder is gone, answers with no local state.
- Topic `github-pr:<workspace id>` sends the status on subscribe and after each poll.

| Route | Does |
|---|---|
| `GET /api/github-pr/workspaces/:id[?refresh=1]` | The status: publishable, form defaults, the PR, watch state and tries, the local head and uncommitted count. `refresh=1` asks GitHub first. |
| `POST /api/github-pr/workspaces/:id/publish` `{ title, body, base, draft?, confirm: true }` | Pushes and opens the PR (201). An open PR is 409 `pr_exists`. |
| `POST /api/github-pr/workspaces/:id/push` `{ confirm: true }` | Pushes new commits to the PR's branch. |
| `POST /api/github-pr/workspaces/:id/watch` `{ on }` | Turns the watch on (a new run of tries) or off. |
| `POST /api/github-pr/workspaces/:id/merge` `{ confirm: true, headId }` | Merges the PR with a merge commit (ADR 0142). |
| `DELETE /api/github-pr/workspaces/:id/merge-when-ready` | Turns off "merge when checks pass" (ADR 0164). No PR is 404 `no_pr`. |

CLI: `pi-spore pr status <workspace>`, `pi-spore pr open <workspace> [--title t] [--body b] [--base branch]
[--draft]` (the form defaults fill what is not given), `pi-spore pr push <workspace>`, and `pi-spore pr watch
<workspace> on|off`.

- The web module adds a PR tab (after Changes) and a "Pull request" panel in Details. The tab asks GitHub on open
  (`refresh=1`) and follows the topic. Without a PR it shows the publish form (title, description, into branch,
  draft) and a warning about uncommitted files; "Push and open PR…" shows a confirm that names the branch and says
  the push is visible to others. With a PR it shows a header card (number, title, state, branch → base, review,
  conflicts), a Push… confirm when the workspace has commits the PR lacks, the checks with state chips and links,
  and the watch: state, tries, last and next look, the message, Resume and send again, Stop watching, and the tries
  so far. A Merge button asks `Merge #n into <base> with a merge commit?` in the `useConfirm` dialog; while
  `mergeBlocked` is set it is off, with the reason in its tooltip. The Details panel shows the number, state,
  failing checks, conflicts, and "Waiting for you". With the choice on, the watch shows "Will merge when checks
  pass" and Turn off, with no confirm. Home shows a `workspace-pr` approval with the title and description to edit,
  and Open PR, Open and merge when checks pass, and Decline.
- "Waiting for you" is also a Home item (a `github-pr` Home source, ADR 0155). Not built yet: PR tools for agents
  (they come through spore-bridge).

## 11f. Artifacts

See [ADR 0070](decisions/0070-artifacts-per-workspace-and-project.md). Requirements R14.

- The `artifacts` module (core, requires `projects`, `workspaces`) keeps files outside every working copy and Git:
  `~/.pi-spore/artifacts/workspaces/<workspace id>/` and `~/.pi-spore/artifacts/projects/<project id>/`. The disk
  holds the content. The table `artifacts_artifacts` holds, per scope, owner, and path, the agent that wrote it last
  (none for the user), the workspace it was promoted from, and the time. A file put there by hand shows with its
  modification time.
- Paths are relative, with `/` between folders, at most 255 characters, without empty, `.`, or `..` parts,
  backslashes, or control characters (400 `bad_path`). Reads use `readFileInside` (`@pi-spore/module-api/node`):
  after resolving symlinks the file must be a regular file inside the owner's folder (403 `outside_root`). Writes
  make folders one at a time and check each real path, and open the file with `O_NOFOLLOW`. At most 10 MiB per
  file (413 `artifact_too_large`).
- Other modules use `ArtifactsKey`: `list`, `read`, `write`, and `promote`. The bridge uses it for the agent tools
  (section 2).
- Routes:

  | Route | Does |
  |---|---|
  | `GET /api/artifacts/workspaces/:id`, `GET /api/artifacts/projects/:id` | `{ artifacts }` of that folder, by path. |
  | `GET /api/artifacts/{workspaces,projects}/:id/file?path=` | The bytes, typed by extension, with `nosniff` and a `sandbox` CSP. |
  | `POST /api/artifacts/{workspaces,projects}/:id/file` `{ path, content }` | Creates or replaces a text file, written by the user. |
  | `POST /api/artifacts/workspaces/:id/promote` `{ path }` | Copies a workspace file to the same path in its project. The original stays. 409 `artifact_exists` if the project has that path; a promotion never replaces. |
  | `POST /api/artifacts/{workspaces,projects}/:id/open-folder` `{ path }` | Opens the folder that holds the file in the file manager of the server's computer (`xdg-open`, `open`, or `explorer`; 501 `unsupported_platform` elsewhere). The real path must be inside the owner's folder (403 `outside_root`). A request with `X-Forwarded-For` or `Tailscale-User-Login` answers 403 `not_local`. |
  | `GET /api/artifacts/local` | `{ local }`: false when those headers are present, so the web can hide the button. |
  | `GET /api/artifacts/workspaces/:id/view?path=` | A Markdown or image file for the viewer, from the workspace folder or its two artifact folders. Other extensions answer 415 `not_viewable`, so `.env` and other repo files stay unreadable here. |

- Topic `artifacts:<workspace id>` sends `{ type: "artifacts", workspace, project }` on subscribe and after every
  write or promotion. A project change goes to every workspace of the project.
- Nothing deletes artifacts: not archive, not retention, not removing a project (R14.3, ADR 0121).
- Web: an Artifacts tab on the workspace lists both scopes, shows the selected file, and promotes workspace files.
  When `GET /api/artifacts/local` says `local`, each row also has Open folder; otherwise the button is hidden.
  The viewer renders Markdown (images in it show as links and never load, ADR 0061), shows images, puts HTML in an
  `<iframe sandbox="">` (no scripts, no same origin), and shows other text as code. In the chat, a link to a local
  `.md` or `.markdown` file opens the same viewer in a dialog through the `view` route. The agents module offers this
  slot as `AgentsWeb.setFileLink`; without it the link stays plain.
- The artifacts web module (requires `workspaces`, `agents`, `attention`) also sets `AttentionWeb.setArtifactLink`:
  a question's Read button opens the file in the same viewer in a dialog, through the `file` route of its scope.
  Escape closes only the dialog, so the question keeps its step and draft (ADR 0200).

## 11g. Agent graph

See [ADR 0176](decisions/0176-live-agent-graph.md). Requirements R3.3, R6, R7, R15.

- The `agent-graph` module (requires `projects`, `workspaces`, `agents`, `pipelines`, `runs`) builds one live picture
  of every agent that works now, as trees. Its one table, `agent_graph_positions`, holds where the user dragged each
  node (ADR 0176, card 4). It reads the other modules only through
  `WorkspacesKey`, `AgentsKey` (`get`, `inWorkspace`, `isClosed`, `attention`, `liveState`), `PipelinesKey` (`get`,
  `runsOf`), and `RunsKey` (`runOf`, `laneOf`). The build is `buildGraph` in `modules/agent-graph/src/graph.ts`.
- Trees, for workspaces in state `active` only, not the planner workspace, oldest workspace first:
  - A run workspace gives a `run` tree: root the coordinator chat, one group per lane whose workspace is active and
    that has a pipeline run. A lane workspace gives no tree of its own.
  - Any other workspace with an active worker chat that is not closed gives a `workspace` tree: root that chat, one
    group per pipeline run that is `running` or `waiting_user`, plus the newest run when it ended.
  - Side chats and planner chats are not in the graph.
- A group (`GraphGroup`) has the pipeline run id, workspace, lane id for a lane, a name (slice name, lane name, or
  pipeline id), the run state, the current stage and round, `live` (state `running`), `merging` while the run
  merges that lane (the lane's `mergeStep`, such as `gate test`, else `merging`; ADR 0150), and its steps in pipeline
  order. A started agent stage gives one step per turn (`task`, `review`, or `fix`, with its round and agent). A
  gate stage gives one `gates` step with the gate names per gate run (`PipelineRun.gateRuns`), with id
  `<pipeline run id>:<stage index>:<round>`; its state comes from the gate run, and a gate round that waits for an
  open fix turn is `waiting`. A stage not started gives one `waiting` step. A group of 2+ stages (ADR 0178) gives one
  row per round: each member's review turns or gate step of the round, every step after the first with
  `beside: true`, then the round's fix turns. After a fix of a live run, its gate members get `waiting` steps of the
  next round until that round starts. A step whose agent retention deleted has no agent. A step can carry an
  `outcome` (ADR 0188, `outcomeOf`): a done review is `approved` or `revise` (with `findings`, the count, when there
  are any), another done turn `reported`, a done gate step `passed`; a running step of a run with `blocked` is
  `blocked` (with `note`, the message), else a running turn with an open question is `asking`.
- An agent node (`GraphAgent`) has its id, workspace, kind, role, title, status, `workingFor`, model, routed model,
  `since` (from `AgentsKey.attention`, else its creation time), and `helpers`: one per `running` step of a
  `running` child run, with id `<child run id>:<step index>`, agent name, model, current tool, and start time. One
  stage agent can back several steps (a task turn and its fix turns); its helpers show on its last node only.
- `GET /api/agent-graph` answers `{ trees }`. Topic `agent-graph:trees` sends `{ type: "graph", trees }` on
  subscribe and again after a change, at most once per tick (`setImmediate`). Changes come from `AgentsKey.onChange`
  and `afterWorkerChange` (a workspace's first chat), `PipelinesKey.onChange`, `RunsKey.onChange`, and the
  workspace state change and delete hooks. Nothing polls.
- Saved places (card 4): each tree carries `positions`, the saved x and y by canvas node id
  (`tree:<workspace id>`, `group:<pipeline run id>`, `step:<step id>`; `treeNodeId`, `groupNodeId`, and `stepNodeId`
  in `packages/shared/src/agent-graph.ts` make them). `PUT /api/agent-graph/positions` with `{ node, x, y }` saves one
  place under the workspace of the tree that shows that node and answers `{ ok: true }`. An id of no node in the
  graph, a helper id among them, answers 400 `unknown_node`, naming it. `DELETE /api/agent-graph/positions` clears
  them all, for the canvas's "Reset layout". A workspace's rows go when it is archived or deleted; a parked one keeps
  them, since it can resume. One `graph()` in `server.ts` builds the graph with its places, and `GET`, the snapshot
  for a new subscriber, and every event use it.
- A helper that stopped running is in the next topic event once more, with state `failed` (its step or run is
  `failed` or `rejected`) or `done`, so the canvas can pop it in the right color; one more event drops it. `GET` and
  the snapshot show running helpers only. Foreground helpers are the parent's `subagent` tool call and are not
  nodes.
- Web: the module fills the workspaces landing page (`#/workspaces`, and `#/workspaces/in/<project>` with only that
  project's trees) through `WorkspaceView.setLanding`, with the label "Agent graph" and the `SporeLogo` icon (the graph's own heading)
  for the list header's link. `canvas.tsx` draws the graph with `@xyflow/react`; it
  subscribes to `agent-graph:trees` and redraws from each event, so an archived workspace's tree leaves at once.
  - Layout: `layoutGraph` in `layout.ts`, a fixed tree layout with no library. Desktop: trees side by side, oldest
    first; in a tree, the root on top and its groups side by side; steps top-down. Phone: trees and groups stack,
    the root thread down the left. Each pod reserves one row per helper under it. A step with `beside` runs in one
    round with the step before it (ADR 0178): on a desktop a round's steps sit side by side, and the group widens one
    column per member past the first; on a phone they stack. Each step's threads start at every step of the round
    before it, so a step forks into a round and the round joins into the next step. The live route ends at the last
    round with a running step: it runs through each earlier round's first step to every running step.
  - Nodes: a tree box (the root pod is its drag handle, so dragging the root moves the tree), a group panel, and a
    step pod. Every pod with an agent links to `#/workspaces/<workspace>/chats/<agent>`. A drag's end sends
    one `PUT /api/agent-graph/positions`; the canvas draws each node at this mount's drag, else at its tree's
    `positions`, else at the automatic place. A step's place is relative to its group, so a moved tree keeps its
    children, and helpers move with their pod. Reset layout sends `DELETE /api/agent-graph/positions`. A failed save
    shows its error over the canvas until the next one works. Fit fits the graph; zoom, pan, and pinch are React
    Flow's.
  - Look (the approved mockup): roots `--accent` (coordinator) or `--accent-strong` (chat); a step pod takes its
    look from the step's own `state`, never its agent's status, since a task step and its fix steps share one
    worker: working `--run` and breathing, done idle gray, waiting an outline, failed `--fail` with an X. A root, or
    a running step, whose chat waits for the user (`waitShows`, read through `AgentsWebKey.useUserWaits`) is
    `--warn` with a steady glow and reads "waiting for your answer". A step with an `outcome` shows it in place of
    its state text (`approved · sonnet 5.5`, `revise · 2 findings · sonnet 5.5`), and its ring takes a tone:
    `--ok` (approved, passed), `--warn` (revise, asking), `--fail` (blocked). A blocked step's hover adds the
    blocked message. A fix step reads `fix r<round>`. In a live
    group, the threads from the root to the running step take the root's color and carry SVG drops. A group with
    `merging` is live too: a `merging: <step>` line in `--run` under its name (its steps move down one line for it),
    and a live thread from the root to its first step; its steps keep their own looks. Reduced motion:
    no drops, no breathing.
  - Helpers (`helpers.tsx`): small spores inside their parent pod, so they move with it and a click opens the
    parent's chat. Hover shows the current tool; a touch screen shows it inline. `useHelpers` keeps their life on
    the client: a helper new after the first snapshot buds (600 ms), an ended one or one that left the list pops
    (about 400 ms; a failed one flashes `--fail` first), then leaves state on `animationend`. Reduced motion: a
    fade.
  - No trees: "No agents work now." and a link to the New workspace page.

## 11h. Remote peers (Hermes)

See [ADR 0202](decisions/0202-hermes-remote-teammate.md) and the facts in
[hermes-protocol.md](spikes/hermes-protocol.md) and [hermes-pi-spore-profile.md](spikes/hermes-pi-spore-profile.md).
Requirements R19, R1.2, R1.4. The connector is built (card Hermes 1.1). Handoffs, the listener, and the chat page
are **planned, not built yet** (cards Hermes 1.2 to 2.3).

The Hermes profile `pi-spore` on the user's Unraid server is a remote teammate. It is not a workbench agent: no
worktree, no pipeline, run, lane, or stage role, and no live agent slot. It is not Homelab Maintainer and has none of
its memories or chats. Its terminal runs in the Hermes container with the `local` backend, so it is **not a
sandbox**.

### Trust boundary

```text
 desktop (pi-spore)                                          │ tailnet │ Unraid, Hermes container
                                                             │         │
 browser, CLI ──► 127.0.0.1:7420  main server                │         │
   (tailscale serve proxies here; ADR 0143)                  │         │
   guardRequest: loopback peer, Host, Origin; user token     │         │
                  │                                          │         │
                  ├─ agents module ─► pi --mode rpc workers  │         │
                  │   (local; agent tokens; ADR 0002, 0032)  │         │
                  │                                          │         │
                  └─ hermes module                           │         │
                      connector, outbound ───── HTTP + SSE ──┼────────►│ :8642 Hermes API, one gateway
                        key ~/.pi-spore/hermes/pi-spore.key  │         │   /p/pi-spore/... (own key; 401 for
                                                             │         │   other profiles' keys)
                      MCP listener ◄──────── MCP over HTTP ──┼─────────┤ profile pi-spore: mcp_servers entry,
                        desktop Tailscale IP only,           │         │   token from its .env
                        port hermes.mcp.port                 │         │
                        token ~/.pi-spore/hermes/mcp.token   │         │   terminal: local backend,
                        task tools only, no shell            │         │   cwd /opt/data/pi-spore-bridge
                                                             │         │ :9119 dashboard (not used by pi-spore)
```

What crosses the boundary: task text, results, approval and clarify questions and answers, run and session status.
What never crosses it: the user token, agent tokens, a shell, an agent home, or a session database. The Hermes key
crosses only in the `Authorization` header of a request to Hermes, and the MCP token only in the header of a request
to the listener.

| Port | Machine | Bound to | Caller | Auth |
|---|---|---|---|---|
| `7420` (`PI_SPORE_PORT`) | desktop | `127.0.0.1` only | browser, CLI, agents, `tailscale serve` | user token, agent tokens |
| `hermes.mcp.port` | desktop | the desktop's Tailscale address only | the `pi-spore` profile's MCP client | MCP token |
| `8642` | Unraid | Unraid's Tailscale address ([hermes-setup.md](spikes/hermes-setup.md) 1.5) | the hermes module | `pi-spore` profile key |
| `9119` | Hermes container | all container interfaces (operator-reported) | not pi-spore | dashboard login; card Hermes 0.6 |

The main server keeps its guards unchanged. The listener does not use `guardRequest`, because its peer is not
loopback. It has its own checks: the MCP token, a known Host, no `Origin`, and caps on body size and request rate.
The Tailscale grant that lets Unraid reach the listener port is applied by the operator with the user's yes (card
Hermes 1.4).

### Connector

- Module `modules/hermes` (`@pi-spore/mod-hermes`, not core, requires nothing). Other modules reach it only through
  `HermesKey` (`modules/hermes/src/contract.ts`). Code: `src/client.ts` (HTTP, SSE, status), `src/key.ts` (key
  loader), `src/protocol/` (TypeBox schemas of every Hermes answer and SSE event it reads).
- Settings, global only: `hermes.enabled` (default `false`), `hermes.url` (default `http://hermes-docker:8642`;
  an origin only: `http://` or `https://`, a host name, an IPv4 or bracketed IPv6 address, and a port; no path, user
  info, query, or backslash), `hermes.profile` (default `pi-spore`), `hermes.keyFile` (default
  `null`: `<pi-spore home>/hermes/<profile>.key`, so `~/.pi-spore/hermes/pi-spore.key`; a set value may start with
  `~/`). Settings hold the path, never the key. Off means no request to Hermes, no listener, no tool, no rail entry.
- Key loader: reads the file on every call. It refuses, naming the path and never the content, a missing or empty
  file, a file mode wider than `0600`, a folder mode wider than `0700`, or bytes a header cannot carry. A refused
  key makes the status `unauthorized`.
- Status check, in order: `/p/<profile>/health` with no key (tested minor `0.23.x`; another names both versions),
  then the required flags of `/v1/capabilities` (spike Q1; a missing or `false` flag is named), then the profile's
  model id in `/v1/models`. Status `disabled`, `unreachable` (no answer, a timeout, or a 5xx), `unauthorized` (401,
  403, or a refused key file), `incompatible` (version, flags, model, or an answer that fails its schema), or `ready`.
- The status is cached per URL, profile, and key file. A poll checks again 60 s after `ready` or `disabled` (off
  reads settings only), and after a failure waits 5 s, doubling up to 5 min. Timers are unref'd. `GET
  /api/hermes/status` (user token) answers the cached status, or checks once if there is none. `POST
  /api/hermes/refresh` checks now. The Settings page shows the status in a "Hermes" panel; its Reload button posts
  the refresh.
- Every client call except `status` reads the settings once and uses that snapshot for the check and the request.
  It refuses with 503 `hermes_not_ready` unless that config is `ready`. A cached failure is checked again first, so
  a call works as soon as Hermes is back. A request
  waits 10 s for its answer (a stream: for its headers), then fails 502 `hermes_timeout`. Hermes errors come back
  as `hermes_<code>` (for example 409 `hermes_idempotency_key_conflict`, 409 `hermes_permission_denied`, 404
  `hermes_run_not_found`).
- Every `POST /v1/runs` has an `Idempotency-Key` (1 to 255 visible ASCII). The body is `{input, session_id}` in a
  fixed key order, so a retry of the same fields is the identical body. Nothing is sent again on its own.
- SSE: frames carry `id:` and `data:`; the event name is `data.event`. `runEvents(id, lastEventId)` sends
  `Last-Event-ID`, yields known events (a `replay.truncated` too), and ends after a terminal one. An unknown event
  name is logged once (at info: the host `Logger` has no debug level) and skipped. A known event without a field
  pi-spore reads fails 502 `hermes_bad_response`. A stream that ends early fails 502 `hermes_stream_lost`, naming
  the last id. Turning `hermes.enabled` off closes open streams at the next check (poll or refresh) with 503
  `hermes_not_ready`. An open stream has no idle timeout yet: a half-open connection waits until Hermes or the
  process ends it. The first card that follows streams adds one, keyed to the 10 s keepalive. Unknown
  fields are allowed everywhere in Hermes data.
- Approval answers are exactly `{request_id, execution_generation, choice}`, `choice` `once` or `deny` (the type and
  a closed schema both refuse `session` and `always`). Clarify answers are exactly
  `{request_id, execution_generation, answer}`. `resolveUnknown` sends exactly `{admission_id,
  execution_generation}`; no code calls it on its own.
- No provider or model override: the outgoing schemas are closed, so a body with `model` or `provider` is refused.
  The provider and model shown come from the session record (`model`, `billing_provider`); blank run runtime fields
  are unknown, not an error.
- No stop hook in `ServerHost`: shutdown ends the process, which closes any open SSE stream, and the module opens no
  listener in this card.
- Tests run against a fake Hermes, `modules/hermes/test-fixtures/fake-hermes.mjs`. It is not live proof; card
  Hermes 1.5 is.

### Handoffs

- Table `hermes_handoffs` holds both directions (`out`: Pi asks Hermes; `in`: Hermes asks Pi).
- **Pi to Hermes:** `ask_hermes` in workspace and planner chats, refused in stage, lane, side, and helper chats, and
  in a chat that works on a Hermes request. A job (`hermes.ask`) makes one API session per handoff, starts the run,
  follows it, and delivers the result to the asking chat in the same commit as the end state.
- **Hermes approvals and clarify** become Home items for the user. Answers post the exact spike bodies, `once` or
  `deny` only. A stale answer shows "expired" and posts nothing.
- **Uncertain** (`unknown` after a Hermes restart): pi-spore reads the session's messages and tool events and shows
  them. The user picks "Mark as interrupted", "Send again", or "Drop". pi-spore never picks.
- **Hermes to Pi:** the listener's tools `list_targets`, `submit_request`, `get_request`, `cancel_request`, each
  deduped by `request_id`. A request becomes a Home approval. On Accept, a new workspace chat in a target from
  `hermes.inbound.projects` gets it, marked as remote input, not the user's approval. Results wait in the table until
  Hermes reads them.

## 11. Unity module

See [ADR 0011](decisions/0011-unity-support.md).

- Detection: `ProjectSettings/ProjectVersion.txt`. Adds traits `unity` and the editor version.
- Worktree copy defaults: `Library/`, `*.csproj`, `*.sln`, with `cp --reflink=auto`. Warns when
  `Temp/UnityLockfile` exists in the main checkout. After the copy, the trait's `afterCopy` hook deletes
  `<worktree>/Library/Bee`: a copied script build graph holds the main checkout's path and makes Unity build DLLs
  whose scripts do not bind ([ADR 0177](decisions/0177-unity-worktree-library-drops-bee.md)). Lane workspaces and the
  run's merge checkout both get it, through `workspaces.create`. If the main checkout's `Library` is a symlink, the
  copy is the same link, so creation fails with 409 `symlinked_library` and removes the new copy.
- Editor control through the `unity` CLI (run with `host.exec`, plus `--no-banner --non-interactive`):
  - `unity open <path>` to open (it returns at once);
  - `unity status --json` to see open editors, their project paths, and pids;
  - `unity close --json <path>` to close (exits without saving, so it is only run after an explicit yes). Without the
    Pipeline package it fails with `PROJECTS_CLOSE_PIPELINE_MISSING`; pi-spore then runs it again with `--force`
    (SIGTERM, then SIGKILL; [ADR 0156](decisions/0156-unity-test-gates.md), spike `spikes/q17-unity-close.md`);
  - `unity test <folder> --mode <EditMode|PlayMode> --output <file> --timeout <s>` for the test gates.
- Finding open editors (ADR 0028). For the main checkout and each workspace folder of the project, an editor is
  open when one of these sees it:
  - a `unity status --json` row with that `projectPath` (only editors whose project has the Pipeline package);
  - a process with `-projectpath <folder>`, from `/proc`;
  - `Temp/UnityLockfile`, but only together with one of the above. A lock file alone is reported as stale and does
    not block. Where processes cannot be listed, a lock file alone counts as open.
- Editor lease, one per project (`unity_leases`): the folder, the workspace, the owner (`user` or `agent`), when it
  was opened, and when its editor was last seen.
  - Opening from the UI takes the lease for the user. Opening a folder fails with 409 `editor_open` while an editor
    has another folder of the project open. The UI then offers "Close without saving" with a confirm that says
    unsaved changes are lost. The close request must carry `confirm: true`.
  - Opening a folder with no editor open yet fails with 503 `no_display` when the server's environment has neither
    `DISPLAY` nor `WAYLAND_DISPLAY`. No lease is saved. The message names the fix: run
    `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY` in a desktop terminal, then
    `pi-spore restart`.
  - The lease is reconciled on every read. An editor that was seen and is gone drops the lease. A lease whose
    editor was never seen counts as a starting editor for 10 minutes, then is dropped. The archive check skips
    `unity status`; it still drops a lease whose editor was seen and is gone, where processes can be listed.
  - Archiving a workspace whose folder has an editor open fails with 409 `editor_open`, even with force.
  - Other modules use the `UnityEditorsKey` interface: `editors(projectId)`, `open(workspaceId, owner)`,
    `close(projectId, path)`.
  - Later: an agent that needs the editor (for unity-mcp work) creates an Approval and opens Unity only after a
    yes. If another agent holds the lease, it waits. If the user holds it, the Approval asks to share or close it.
- Test gates (R10.6, [ADR 0156](decisions/0156-unity-test-gates.md)). The module provides the actions
  `unity-test-editmode` and `unity-test-playmode` for Unity projects (section 13, provided actions). A pipeline
  gate stage lists them like any action. A run:
  1. Looks every 5 s at the editors on the workspace's folder (other folders of the project do not block). With
     none, it goes on. If an agent holds the lease, it waits. Otherwise (the user's lease, or an editor opened
     outside pi-spore) it files a `unity-close-editor` approval `{ projectId, path }` for the workspace's active
     chat (created if the workspace has none) and waits. A question left open by a cancelled gate is reused, and an
     approve may not change its folder. Approve checks again, and closes (above) without saving only if the user's editor is still open; decline fails the gate; quitting Unity by hand
     also lets it go on. Cancelling the run ends the wait. Nothing closes without an approve.
  2. Runs `unity test` with an argv array and a 30 minute `--timeout`; pi-spore stops the process itself a minute later. Output goes to the run's log, so a failed
     gate shows the log tail to the pipeline (R6.5).
  3. Stores the report (NUnit XML) as the workspace artifact `unity-tests/<run id>.xml`. Exit code 0 with no report
     fails the run.
  4. Counts the lines `The referenced script (Unknown) on this Behaviour is missing!` in
     `<worktree>/Logs/Editor.log`, if this run wrote that file. At 100 or more, the run fails with
     `stale Unity Library cache in <worktree>: <n> missing-script lines. Run the unity-repair-library action, then Retry.`
     Only the count leaves the log (it holds an access token). ADR 0177.
- `unity-repair-library`, a provided action for Unity projects: deletes `<worktree>/Library/Bee` so Unity rebuilds
  its scripts on the next open. It refuses the main checkout (an `in-place` workspace) and a folder that an editor
  has open, and logs only the path. Run it from the Actions panel or with `run_action`.
- API under `/api/unity`: `GET /workspaces/:id` (Unity or not, the editor version, open editors, stale lock
  files, the lease, and `tests`: the last 5 gate runs with mode, status, and the report path), `POST /workspaces/:id/open`, `POST /editors/close` `{ projectId, path, confirm: true }`. The
  workspace view has a Unity panel for Unity projects.
- unity-mcp per worktree: the relay accepts `--project-path`. Agents get `PI_SPORE_UNITY_PROJECT=<worktree>`, and
  `~/.unity/relay/unity-mcp.sh` passes it on when set (ADR 0011).
- A Unity project's pipeline lists the test gates in a gate stage, for example
  `gates = ["check", "unity-test-editmode"]`. To run both modes, list them in one gate stage (ADR 0178 rule 18).
  In a parallel group the gates run next to the reviews, but the test gates are exclusive per folder, so two of them
  never run at the same time: the second waits in the actions queue, then takes the editor lease in its turn. The
  Unity panel shows the last gate runs: mode, status, and the report artifact. The log of a run is in the Actions
  panel.

## 12. Kanban

See [ADR 0012](decisions/0012-kanban.md) and [ADR 0040](decisions/0040-card-moves-on-workspace-state.md). Requirements
R11.

- The `kanban` module (`modules/kanban/`, not core, requires `projects`, `workspaces`, `agents`, `attention`, and
  `runs`)
  owns three tables: `kanban_cards` (title, Markdown body, project, labels, due day, column, position, the workspace
  started from it, the agent that created it and the one that changed it last, and an optional `model`, `provider/id`
  checked with a TypeBox pattern, for the chat that work from the card starts, ADR 0120),
  `kanban_links` ("blocked by": a card or a workspace), and `kanban_events` (each move between columns, with its
  reason).
- Columns are fixed in v1: Backlog, Ready, In progress, Review, Done. `position` orders a column from 0; every move
  renumbers the columns it touches.
- A blocker is open while its card is not in Done or its workspace is not archived. A card is blocked while any
  blocker is open. A card cannot block itself.
- Due dates are calendar days (`YYYY-MM-DD`). The board compares them with the browser's local day: a card in any
  column but Done is overdue after its day, and "due today" on it.
- Removing a project leaves its id on cards; the board shows "removed project".
- Retention (ADR 0121) never deletes a card. When it deletes a workspace, the workspace's cards lose the link and get
  `archived_at`, and blocker links to that workspace go. The board hides archived cards behind a "Show archived"
  toggle, shown only when there are any. Any move clears the mark.
- Starting work from a card (R11.4, ADR 0100): `POST /api/kanban/cards/:id/start` with either the create-workspace
  fields (a new workspace through `WorkspacesKey.create`, named after the card) or `{ workspaceId }` (an active
  workspace of the card's project; a parked one is 409 `workspace_not_active`, the planner workspace 409
  `planner_workspace` (ADR 0174), another project's 422
  `project_mismatch`). The card links to the workspace and moves to In progress, and in the same transaction its
  brief (title, labels, due day, blockers, notes) goes to the workspace's active orchestrator chat through
  `AgentsKey.deliver`. `AgentsKey.activeWorker` creates that chat if the workspace has none. A busy worker gets the
  brief as a follow-up after its current run. A card with an open workspace answers 409 `card_has_workspace`. A
  blocked card answers 409 `card_blocked` unless the request carries `confirmBlocked: true`; the board asks the user
  first.
- A card also starts a new run (R7): `POST /api/kanban/cards/:id/start` `{ run: true, base?, projectId?, model?,
  confirmBlocked? }` creates it through `RunsKey.create` (section 9), named after the card (cut to 120 characters).
  The card links to the run workspace and moves to In progress with reason `run-started`, and its brief goes to the
  coordinator chat, in one transaction. A project without `integrate` answers 422 `not_supported` and the card stays
  where it was. Because the card links to the run workspace, it follows the run through that workspace: a PR on it
  → Review, its archive → Done. Runs have no archive of their own.
- A lane that names a card (ADR 0180, section 9) links it through the linker kanban sets with
  `RunsKey.setCardLinker`. The linker refuses a card that is missing, has no project, or is of another project (404
  `card_not_found`), a card in Done (409 `card_done`), and a card an open workspace other than the run workspace
  holds (409 `card_has_workspace`, naming that workspace). Then it links the card to the run workspace, not the lane
  workspace, and moves it to In progress with reason `lane-started`. From there it follows the run as above. The
  coordinator still never changes a card itself (ADR 0154).
- The model of the new chat (ADR 0120): the request's `model`, else the card's, else `agentOverrides.orchestrator`.
  It goes to `AgentsKey.activeWorker`, or for a run to the coordinator through `RunsKey.create`. In an existing workspace the chat keeps its model, so a `model` in the request
  answers 400 `model_needs_new_workspace`; the card's model is then unused.
- Agents (ADR 0100) reach cards through `CardsKey` from the bridge module: cards of their own project only, with
  `createdBy` and `changedBy` set to the agent and its workspace. A change or move by the user clears `changedBy`.
  A move by an agent is recorded with reason `agent`. `CardsKey.requestStart` checks the card and target, then files
  a `card-start` approval (subject `{ cardId, target, model? }`); approving it starts the work as above, with the
  target and model the user chose (a changed subject is checked with the same schema), and tells the asking agent
  where it started.
- Automatic moves happen only on a state change, so a manual move stays until the next one:
  - workspace or run started from the card, or a lane that names it → In progress;
  - workspace archived → Done (any archive; the user moves the card back if the work was dropped). The module
    listens with `WorkspacesKey.afterStateChange`.
  - Later modules move cards through `CardsKey.workChanged(workspaceId, column, reason)`: pipeline passed or PR
    open → Review, PR merged → Done. `github-pr` finds a workspace's PR by itself (section 11e), also one an agent
    opened with `gh`, so the card reaches Review and Done without the publish form.

API under `/api/kanban`:

| Route | Does |
|---|---|
| `GET /cards?projectId=&label=&workspaceId=` | Cards in board order. |
| `POST /cards` `{ title, body?, projectId?, labels?, due?, column?, blockedBy?, model? }` | Adds a card at the end of its column (default Backlog). |
| `GET /cards/:id` | The card and its history of moves. |
| `PATCH /cards/:id` | Changes the fields given; `null` clears project, due, or model. `blockedBy` replaces the list. |
| `POST /cards/:id/move` `{ column, index? }` | Moves or reorders. Without `index`, the card goes to the end. |
| `DELETE /cards/:id` | Deletes the card, its links both ways, and its history. |
| `POST /cards/:id/start` `{ …, model? }` | Starts work from the card in a new or an existing workspace, or a new run (above). |

- Topic `kanban:board` sends every card on subscribe and after every change.
- The Board page (`#/board`, `#/board/<card id>`, rail icon) shows the columns with a project and a label filter.
  Cards move by drag and drop, or with the move buttons on each card (keyboard). Selecting a card opens it on the
  right: edit, move, delete, blockers, history, and "Start a workspace" with the workspaces module's create form
  (`WorkspaceViewKey.CreateForm`). The workspace view has a Card panel for the workspace's card.
- Each card tile has a Start button (R11.4) when the card has a project, no workspace, and is not Done. One click
  sends `POST /api/kanban/cards/<id>/start` with `{ projectId, isolation: "new" }`: a new workspace on the
  project's default branch, with the card's model. A blocked card asks first and then adds `confirmBlocked: true`.
  After the start it opens the workspace. When the start left warnings or failed steps, it opens the card instead,
  and the card's Work section shows them, the same as after the Work section's own new-workspace form.
- The Work section offers "Start in a new workspace" (the create form), "Start in an existing workspace" (the
  project's active workspaces), and "Start a run" (a base line, a model, and a git project when the card has none). Cards made or changed by an agent show an agent chip, and the card panel names the
  agent's workspace with a link to its chat. Home shows a `card-start` approval with the card, whether it is
  blocked, the reason, and a target picker.
- A Model picker (ADR 0120) sits in the "new workspace" form (through `CreateForm`'s `children`), in the card
  editor, and in the `card-start` approval. Its list comes from `GET /api/agents/models`, loaded once per picker.
  It is the shared `ModelPicker` from `@pi-spore/ui`: a search box, a Suggested group (`spore/auto`, then tiered
  models low to high), and the other models folded under their provider. Its first item sends no model: in a start
  it is "Card's model (…)" when the card has one, else "Default (orchestrator setting)"; in the editor it clears the
  card's model. The start forms begin on that first item; the approval begins on the subject's model. A model that
  the list does not hold still shows on the button, so loading never changes the selection. A list that fails to load shows a notice and never blocks a start. For an existing
  workspace the picker is disabled with "This workspace's chat keeps its model." and no model is sent. Approving
  with a changed model sends the changed subject.
- CLI: `pi-spore card list [--project p] [--label l]`, `pi-spore card add <title> [--project p] [--due YYYY-MM-DD]
  [--label l] [--column c]`, `pi-spore card move <id> <column>`, `pi-spore card rm <id>`, `pi-spore card start <id>
  --new [--mode m] [--line b] [--base b] | --workspace <id> | --run [--base b] [--blocked-ok]`.
- On a phone the Board shows one column, chosen with a row of column buttons and kept in `?pane=<column>`. Without
  a pane it opens the first of Ready, In progress, and Review that has cards, else Backlog (`phoneColumn`). The card
  editor is full screen with a Back button, and the move buttons show on touch screens.
- Overdue and due-today cards show on Home (a `kanban` Home source, ADR 0155). Not built yet: custom columns.

## 13. Settings

- Sources, later wins:
  1. built-in defaults;
  2. `~/.pi-spore/settings.json` (global);
  3. `<project>/.pi-spore/config.toml` (project file, may be committed);
  4. `<project>/.pi-spore/config.local.toml` (local override, gitignored);
  5. run or workspace override in the store.
- Every resolved value carries its source. The UI shows it. Sources are `default`, `global`, `project file`,
  `local override`, `detected`, `workspace`, and `run`. "Detected" values (Unity traits, editor version) come
  from modules.
- The project file is checked on load and must not contain model keys. Model choices live in Pi settings, global
  settings, or local overrides.

The resolver is `createSettings` in `packages/server-core`; modules reach it as `host.settings`.

- A module declares a key in its setup: `host.settings.declare({ key, schema, default, scope })`. The key is a dotted
  path, the same in JSON and TOML (`agents.maxLive` is `{ "agents": { "maxLive": 4 } }` in `settings.json`). Scope
  `global` means only `settings.json` may set it; scope `project` means the two TOML files may too.
- `host.settings.resolve({ projectPath?, detected? })` reads the files fresh and returns each declared key as
  `{ value, source }`. Without `projectPath` only `settings.json` counts. `detected` is a map of values a module
  found, such as the worktree copy list for a Unity project. It sits above the default and below every file.
- Unknown keys, wrong types, a global key in a TOML file, and broken JSON or TOML are errors that name the key and
  the file: 422 `bad_settings` for `settings.json`, 422 `bad_project_config` for the TOML files. So is a model key
  (`model`, `models`, `provider`, `thinking`) anywhere in `config.toml` (R17.3). `config.local.toml` and
  `settings.json` may hold model choices, but only under a key a module declares. A bad file also stops anything
  that reads settings, such as creating a workspace. Nothing falls back to a default. A key with a dot in its name
  (`"a.b" = 1`) is an error: write nested keys as tables, so the model-key scan sees every path.
- Modules declare in their setup, in dependency order, and one may resolve before a later module has declared. So
  until every module is set up, a key nobody has declared yet is not an error. Then the server calls
  `finishDeclaring`, which checks `settings.json` against every declaration. A bad file stops startup with the error
  above, and a declaration after that throws.
- A section another owner reads is reserved with `host.settings.reserve("global" | "project", section)`: the
  projects module reserves `router` and `tiers` (the router extension reads them, section 10), the actions module
  reserves `actions`. Reserved sections skip the unknown-key check. `host.settings.configFiles(projectPath)` and
  `checkSection(schema, value, what)` give the owner the parsed file and the same 422 error.
- The run or workspace override is the last layer (ADR 0166): `resolve({ projectPath, detected, override })`, with
  `override = { source: "workspace" | "run", values }`. `values` is a nested table like the files. It sets only
  declared `project` keys, never a reserved section, and never a model key (R17.3). A bad one answers 422
  `bad_override`, naming the key and "workspace override" or "run override".
- A workspace gets its override when it is made: `POST /api/workspaces` takes `settings`, and the workspaces module
  stores it in `workspaces_workspaces` (`settings`, `settings_source`). It is checked before the copy is made, so
  the branch prefix and copy list use it. `POST /api/runs` takes `settings` too. The runs module stores it in
  `runs_runs.settings` and passes it to the run workspace and every lane workspace, with source `run`. A bad one
  answers before the run line exists. Nothing changes an override later, because nothing reads project settings
  after a workspace is made.
- `GET /api/workspaces/:id/settings` lists every declared key for that workspace with its source. The Settings page
  shows it under "Workspace settings" for the workspace picked there. The CLI sets an override with repeated
  `--set <key>=<value>` on `ws new` and `run start`; a value that parses as JSON is JSON, else a string.
- Saving a setting (ADR 0170): `host.settings.write(target, key, change, check?)` sets one key to a value or
  unsets it. Unset removes the key and any table it leaves empty, so the next layer applies. `target` is
  `{ file: "global" }` (`settings.json`) or `{ file: "local", projectPath }` (`config.local.toml`). Nothing writes
  `config.toml`, and workspace overrides stay read-only. The key must be declared, or sit in a reserved section
  whose owner passes `check`. The whole new file is checked like a resolve, then `check` runs. A failure answers
  422 `bad_settings` or `bad_project_config`, names the key, and leaves the file as it was. Writes go to
  `<file>.tmp`, then a rename, one at a time. TOML is rewritten with smol-toml, so comments in
  `config.local.toml` are lost.
- `PUT /api/projects/settings` saves to `settings.json`; `PUT /api/projects/:id/settings` saves to that project's
  `config.local.toml`. The body is `SaveSettingRequest`: `{ key, value }` or `{ key, unset: true }`. The answer is
  `{ setting }`, the resolved entry with its new source. A global save also runs the router's parser
  (`resolveSettings`) on the whole file, so a bad `router.*` or `tiers` value answers 422 `bad_settings`. The page
  sets only the router keys it lists, never a whole `router` section, and never the `actions` section.
  Idempotency keys work as for every PUT (R16.2).
- The Settings page (`#/settings`) gives each global row Edit and Reset; the project page does the same for
  `worktree.copy` and `worktree.branch_prefix`. Edit opens a field in the row: text for a string, JSON for a number,
  a `true`/`false` select for a boolean (Save sends a JSON boolean), a JSON text area for an array or object. Save sends `{ key, value }` and Reset sends
  `{ key, unset: true }` to the PUT route above. After it works, the panel loads again from its GET route, so the
  row shows the server's value and source. A failure shows the server's message in the row. After a save of an
  `agents.*` or `server.*` key, the row says "Restart pi-spore to apply". A change to `server.allowedHosts` or
  `server.allowedLogins` asks first ("Change remote access?"), because a wrong value can lock you out. The
  "Workspace settings" panel stays read-only. Other web modules add panels between "Global settings" and
  "Workspace settings" through `SettingsPageKey` (`modules/projects/src/web-contract.ts`), sorted by `order`. The
  agents module adds "Role models" there: one row per role and subagent with a model picker and Reset, which save
  at once with `PUT /api/agents/role-models/:name` and show the list it answers (ADR 0181). The hermes module adds
  "Hermes": the connector's status (section 11h).

- Role models (ADR 0181) live in Pi's own file, not in pi-spore's: `<agentDir>/settings.json` (`PI_CODING_AGENT_DIR`,
  else `~/.pi/agent`), key `subagents.agentOverrides.<name>.model`. pi-subagents reads the same key for its helpers.
  `GET /api/agents/role-models` lists the pi-spore roles (`orchestrator`, `planner`, `coordinator`, `worker`,
  `reviewer`, `adversarial-reviewer`), pi-subagents' built-in agents (the `agents/` folder of the installed package),
  the user's agents (`<agentDir>/agents/**/*.md`), and every name already in `agentOverrides`. Each entry has `name`,
  `kind` (`role` or `subagent`), `model` when set, and `fallback: "orchestrator"` for `planner` and `coordinator`. Each
  also has `description`: one line on what the name does. A pi-spore role has a fixed note, even when pi-subagents has
  an agent of that name. Any other name has the frontmatter `description` of its file, the user's file winning over the
  built-in one; a name with no file, or with an empty value or an unquoted YAML block (`>`, `|`), has none.
  `PUT /api/agents/role-models/:name` takes `{ model }` or `{ unset: true }` and answers the new list. The model must
  be in `GET /api/agents/models` (422 `unknown_model`); the name must be listed (404 `unknown_role`). It changes only
  that `model` key; unset also removes the name's object when it is left empty. Writes go to `<file>.tmp`, then a
  rename, one at a time. A file that is not plain JSON answers 409 `pi_settings_not_json`, and a container that is
  not an object 409 `pi_settings_shape`; neither is rewritten. Agent tokens cannot reach these routes. The code is
  `modules/agents/src/role-models.ts`.

Declared keys (`GET /api/projects/settings` lists them all with their source, plus the router keys of section 10;
the Settings page, `#/settings`, shows that list):

| Key | Scope | Type | Meaning |
|---|---|---|---|
| `retention.days` | global | whole number, 0 or more, default 30 | Delete the data of finished work after this many days (section 14). `0` keeps everything. |
| `worktree.copy` | project | array of patterns, default none; Unity adds its list as `detected` | Files a new copy needs (R2.6). |
| `worktree.branch_prefix` | project | string, default `spore` | Prefix of the branches pi-spore creates. |
| `agents.maxLive` | global | whole number, 1 or more, default 8 | Live agent processes at once (ADR 0026). |
| `agents.idleStopMinutes` | global | whole number, 1 or more, default 10 | Idle minutes before an agent stops (ADR 0026). |
| `agents.maxSubagentDepth` | global | whole number, 0 or more, default 2 | How deep pi-subagents helpers may nest. Passed to each agent as `PI_SUBAGENT_MAX_DEPTH` (ADR 0168). |
| `agents.maxImageBytes` | global | whole number, 1 or more, default 10 MiB | Largest image in a message (ADR 0060). |
| `agents.maxImagesPerMessage` | global | whole number, 1 or more, default 8 | Images in one message (ADR 0060). |
| `server.allowedHosts` | global | array of host names, default none | Tailnet hosts that `tailscale serve` forwards from (ADR 0143). |
| `server.allowedLogins` | global | array of Tailscale logins, default none | Logins that may use those hosts (ADR 0143). Required when `server.allowedHosts` is set. |

The `agents.*` and `server.*` keys are read when the server starts. Change them, then restart. Core declares the
`server.*` keys in `setupModules`.

### Remote access

See [ADR 0143](decisions/0143-phone-over-tailscale-serve.md).

The server binds `127.0.0.1` only. A phone reaches it through `tailscale serve --bg <port>`, which the user runs
once; it proxies `https://<machine>.<tailnet>.ts.net/` to the loopback port and sets `Tailscale-User-Login`.
`guardRequest` (`packages/server-core/src/guards.ts`) runs first on every HTTP request and WebSocket upgrade:

1. The TCP peer must be loopback, or 403 `bad_peer`.
2. A loopback Host passes.
3. A Host in `server.allowedHosts` needs a login in `server.allowedLogins`, or 401 `identity_required`. This
   covers the page that holds the token.
4. Any other Host: 403 `bad_host` (DNS rebinding guard).
5. Upgrades only: Origin absent, loopback, or `https://<allowed host>`, or 403 `bad_origin`.

The token check follows for `/api/*` and sockets. pi-spore never runs `tailscale` and never uses Funnel.
`pi-spore remote` prints the serve command and the URLs.

The Hermes MCP listener is the one listener outside these rules. It binds the desktop's Tailscale address, on its
own port and token, and is off by default (section 11h, ADR 0202).

`config.toml` sketch:

```toml
[worktree]
copy = ["Library", "*.csproj", "*.sln"]   # Unity default when detected
branch_prefix = "spore"

[actions.setup]
run = ["./tools/setup.sh"]

[actions.test]
run = ["npm", "test"]
exclusive = true

[actions.dev]
run = "npm run dev -- --port 4000"
shell = true
description = "Dev server"
```

### Actions

See [ADR 0027](decisions/0027-actions.md). The `actions` module reads `[actions.<name>]` tables:

| Key | Type | Meaning |
|---|---|---|
| `run` | argv array, or string | The command. A string needs `shell = true`; an array must not have it. |
| `shell` | bool, default false | Run `run` as `/bin/sh -c <run>`. |
| `exclusive` | bool, default false | At most one exclusive run per folder; others wait in line (R12.2). |
| `description` | string | Shown in the UI and CLI. |

- Names are lowercase letters, digits, `-` and `_` (up to 64). Other keys and model keys are rejected with 422
  `bad_project_config`.
- The local override replaces a whole action of the same name. Each action shows its source.
- `setup` runs after a new copy is made and the copy list is done. `teardown` runs on archive before the copy is
  removed. Neither runs for a workspace in the main checkout.
- A run's cwd is the workspace folder. Its env is the server's plus `PI_SPORE_WORKSPACE_ID`,
  `PI_SPORE_WORKSPACE_PATH`, and `PI_SPORE_PROJECT_ROOT`. Relative programs such as `./tools/setup.sh` resolve in
  the workspace folder.
- Output goes to `~/.pi-spore/logs/actions/<workspace id>/<run id>.log`. Run records (status, exit code, times) are
  in the `actions_runs` table.
- Run states: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted` (the server stopped).
- Triggers: `user`, `agent`, `create`, `archive`, `pipeline`. `ActionsKey.start(workspace, name, trigger, { key })`
  with a key the workspace used before returns that run and starts nothing, so a pipeline gate never runs a check
  twice.
- Provided actions ([ADR 0156](decisions/0156-unity-test-gates.md)). `ActionsKey.provide(action)` adds an action
  for projects with a trait; the unity module's test gates are the first. It is listed with source `default` and
  is exclusive per folder. A run is an ordinary run, except that the module's `prepare` step runs first (wait, then
  name the argv and an optional deadline `timeoutMs`) and its `after` step runs when the process has exited, also after
  a cancel or timeout, which it is told about. A throw in either fails the run with its
  message. Cancel aborts `prepare`. A project action of the same name replaces it. `ActionsKey.runs(workspace, { actions?, limit? })`
  lists a workspace's runs for other modules; `actions` filters before the limit.

API under `/api/actions`:

| Route | Does |
|---|---|
| `GET /workspaces/:id` | The workspace's actions with their source. |
| `GET /workspaces/:id/runs` | The last 50 runs. |
| `POST /workspaces/:id/runs` `{ action }` | Starts a run (active workspaces only). |
| `GET /runs/:id?wait=<ms>` | One run; with `wait`, answers when it ends or the time is up (at most 30 s). |
| `GET /runs/:id/log?from=<byte>&wait=<ms>` | Log bytes from `from` (or the tail), up to 256 KiB. With `wait`, holds the request until there is new output or the run ends. |
| `POST /runs/:id/cancel` | SIGTERM to the run's process group, SIGKILL after 5 s. |

CLI: `pi-spore action list <workspace>`, `pi-spore action run <workspace> <name>` (follows the log, exits 1 if the
run fails), `pi-spore action cancel <run>`. The workspace view has an Actions panel.

In the Actions panel's log view, `http://127.0.0.1:<port>` and `http://localhost:<port>` URLs are links that open
in a new tab. Other hosts stay plain text. While a run is `running` and its log has such a URL, the log header shows
an Open button with the newest one.

#### Test a workspace's changes

See [ADR 0161](decisions/0161-dev-server-for-the-user.md). pi-spore's own `[actions.dev]` runs
`scripts/dev-server.mjs`:

- Click Run on `dev` in the workspace's Actions panel. The script builds, then starts the worktree's server on a free
  port and prints `pi-spore dev server: http://127.0.0.1:<port>/`. Click Open. Cancel stops it.
- The home is `<worktree>/.pi-spore-dev/home` (gitignored). It is kept between runs. To reset it, delete
  `.pi-spore-dev/`.
- The first run makes `.pi-spore-dev/sample-repo`, a new git repo with one commit, and adds it as the dev server's
  project. The real repo is never added: the worktree shares its `.git`, so dev branches would show up there.
- The dev server does not get the real server's `PI_SPORE_URL`, `PI_SPORE_TOKEN`, `PI_SPORE_SERVER_PID`, or the
  workspace and agent names. It never reads `~/.pi-spore`. Each run gets its own port, so two workspaces can run
  one each. Two runs in one worktree share the home, and the second fails on the home lock.
- The dev server's agents use real models and spend tokens.

The workspaces module calls other modules around a copy through its contract: `afterCopyCreated` and
`beforeRemoveCopy` return step reports, which the create and archive responses list in `steps`. A failed
`beforeRemoveCopy` step answers 409 `<step>_failed` unless the archive is forced. An archive asks the provider
`lostWork` before it stops anything: a copy that holds work answers 409 `uncommitted_work`, and the chats,
terminals, and runs of the workspace keep running, because the removal would refuse anyway and leaving active
cannot be undone. While an archive runs, `archiving()` names the workspace, so a module that reads its worktree
can tell a removal in progress from a broken copy. `afterStateChange` runs after every park, resume, and archive;
a listener that throws is logged and does not undo the change. `create` makes a workspace as
`POST /api/workspaces` does, for modules that start work, such as kanban. `archive(id, { force })` is the archive
route's body, with the same errors. `archiveOnMerge(id)` gives the workspace's own `archiveOnMerge`, else the
global setting `workspaces.archiveOnMerge` (default `true`, ADR 0197). `PATCH /api/workspaces/:id` takes `name`,
`archiveOnMerge` (`true`, `false`, or `null` to follow the setting), or both; an empty body is 400 and an archived
workspace is 409 `bad_state`.

The workspace view has three panes: the workspace list (grouped by project, sorted by name, then active, parked,
and archived behind a toggle, newest activity first), the selected workspace's middle pane, and a right column with workspace details and module
panels. Routes: `#/workspaces` and `#/workspaces/in/<project>` (filtered to a project) show the landing page, and
`#/workspaces/new` and `#/workspaces/new/in/<project>` show the create form. `#/workspaces/<id>` shows one workspace.
One component serves them all, so the list keeps its state. The router takes the first page that matches, so the new
workspace pages are added before `#/workspaces/<id>`: `new` is never a workspace id. The list
follows the topic `workspaces:list`: a snapshot of every workspace on subscribe and after a reconnect, then one
`workspace` event for each create, rename, park, resume, and archive, wherever it came from. An active or parked
row shows an archive button on hover or keyboard focus. It asks first, as the Details archive does. With more than
one project in the list, each project heading folds its group to the name and a count of its shown workspaces. The
browser stores the choice per project (`pi-spore.workspaces.collapsed.<projectId>`). A row whose workspace has
open chats shows a chevron toggle at the left of its name. It expands the row to a link per chat, to
`#/workspaces/<id>/chats/<chat>`, in chat bar order, with older orchestrator chats left out. The link of the
route's chat is marked current, and a working chat shows a pulsing dot. Rows start collapsed; the browser stores
the choice per workspace (`pi-spore.workspaces.chats.<workspaceId>`). The Details tab's "Workspace" section shows
the name, state, line, project, and folder, with Rename, Park or Resume, and Archive. For a workspace that is not
archived, it also has the select "Archive when the PR merges": "Use the setting (on)" or "(off)", read from
`GET /api/projects/settings` when the section mounts, then "On" and "Off". A change sends
`PATCH /api/workspaces/:id` with `archiveOnMerge` `null`, `true`, or `false`. The select shows the workspace from
`workspaces:list`, so it follows changes made elsewhere. Other web modules
fill it through the workspaces web interface `WorkspaceViewKey`:

- `addPanel` adds a section to the right column (Actions, Unity). A panel renders its own `CollapsibleSection`, so
  it can render nothing when it does not apply. Panels are keyed by workspace, so each workspace gets a fresh panel.
  They mount only while Details is open. Each panel calls `onLoaded` once its first load ends, with data or with an
  error. The Details tab shows a spinner until all panels of that mount have. A call from an earlier mount changes
  nothing.
- `addTab` adds a tab after Details (Terminals). A `wide` tab widens the column while it is open. Its component
  mounts only while the tab is open.
- `setMain` sets the middle pane. The agents module sets the chat. The route `#/workspaces/<id>/chats/<chat>`
  passes `chatId`; without it the pane shows the active orchestrator chat.
- `setLanding` sets the landing page: what `#/workspaces` and `#/workspaces/in/<project>` show with no workspace
  open (ADR 0176). It also takes the label and icon of the list header's link to that page, before the New workspace
  button. The link keeps the list's project and is lit while the landing page shows. Without a landing those routes
  show the create form, and the header has no such link.
- `setStatus` sets a React hook that returns one status line per workspace, with the row's open chats in `chats`
  (label, hint, icon, and whether it works). The agents module subscribes to
  `agents:list`, which sends a snapshot on subscription and updates as chats are created or change. Reconnection
  supplies a fresh snapshot. A busy, starting, or waiting stage agent of the workspace wins first: "Working:
  <title>" (tone `run`), or "Waiting for a free agent slot" (tone `warn`), since the worker chat of a pipeline or a
  run lane sits stopped while stages work. A stage that works beats one that waits. An idle, stopped, or failed
  stage agent never shows. Otherwise the status line follows the active orchestrator chat. When that chat is idle or
  stopped and waits for the user, or has a dialog open while busy (`waitShows`, section 11b), the line says "Waiting
  for your answer". Otherwise an idle chat with a running helper (`helpersRunning`, section 2) says "Working (helper
  running)", tone `run`. An idle or stopped chat with its own `workingFor` says "Working (<label>)". A busy chat
  whose router waits for a local model shows its `routerStatus` ("Waiting for <model>", section 10), tone `warn`.
  Last, where the line would say "Idle", "Agent stopped", or "No agent yet", the workspace's own working label from
  `agents:working` (section 2) shows instead: "Working (<label>)", tone `run`. So a run lane at its `gates` stage
  says "Working (Pipeline: gates)", like its coordinator.
- `CreateForm` is the "Start a workspace" form. Another module can fill in the name, lock the project, and send
  the request to its own route. The board uses it to start a workspace from a card.

Both side panels resize by dragging their inner edge or with the arrow keys (16 px, 64 px with Shift). The list runs
from 200 to 480 px and the right column from 280 px to 70% of the window. The chat keeps at least 360 px. A double-click
on the edge resets the width. Each width is stored in the browser. A wide tab shows the larger of the stored width and
its own default (640 px, or half the window). A terminal fits once when a drag ends.

On a phone the view shows one pane (`phonePane` in `modules/workspaces/src/panel-layout.ts`). The chat fills the
screen under a bar with a menu button and one button per right tab. `?pane=list` opens the list as a drawer;
`?pane=<tab id>` opens that tab as a full-screen sheet with a Back button. No resize handles; the stored widths and
open flags are not touched. The archive button shows on touch screens. Diffs are always unified on a phone.

## 14. Data layout

```text
~/.pi-spore/
  settings.json          global settings and disabled modules (projects live in the store)
  token                  API token (0600)
  data/pi-spore.sqlite   store (+ .lock)
  sessions/<workspace>/  Pi session JSONL files
  worktrees/<project>/<slug>-<id>/
  artifacts/workspaces/<workspace>/   workspace artifacts (kept after archive)
  artifacts/projects/<project>/       project artifacts
  pipelines/             user pipelines
  usage/<plan>.json      latest plan usage snapshots (written by the usage tap)
  usage/routing.jsonl    routing decisions (written by the router)
  logs/actions/<workspace>/<run>.log   action run output
  hermes/                (0700) Hermes key and MCP listener token, read by the hermes module (ADR 0202)
    pi-spore.key         Hermes profile key (0600)
    mcp.token            MCP listener token (0600)
```

The server and agent stderr are not written to files.

### Retention

See [ADR 0121](decisions/0121-retention.md). The workspaces module sweeps once after startup and then once a day.
With `retention.days = N` (N > 0), it deletes data older than N days:

- an archived workspace, counted from `archived_at`: its session folder, chats, deliveries, questions, approvals,
  review comments, PR records, action runs and logs, and Unity lease, then its row. A `removed` event on
  `workspaces:list` drops it from the list.
- a closed chat, counted from `closed_at`: its session file, deliveries, questions, approvals, and row. The server
  forgets it too, so its id answers 404. A closed chat stays while an open fork of it has not started.
- action runs that ended before the limit, in any workspace, with their logs;
- lines of `usage/routing.jsonl` with an older `at` (unreadable lines stay), and `usage_outcomes` rows that ended
  before the limit;
- stored API responses (`core_idempotency`);
- jobs that ended (`done`, `cancelled`) before the limit (`core_jobs`).

It never deletes active or parked workspaces, git branches, kanban cards, artifacts, the folder of an in-place
workspace, or anything outside `~/.pi-spore`. Modules take part through `WorkspacesKey.onRetention(cutoff)` and
`WorkspacesKey.beforeDeleteWorkspace(workspace)`, and attention through `AgentsKey.beforeDeleteChat(agentId)`. Each
deletes its own rows and files. A listener that fails is logged; a workspace or chat whose cleanup failed keeps its
row and is tried again on the next sweep. Each kind of data deleted gets one log line with a count.

## 15. API, events, CLI

- REST under `/api/<module>/...`, schemas in TypeBox, validated at the boundary.
- One WebSocket at `/api/ws` for server events and one per terminal. Topics: `agent:<id>` (one agent's stream),
  `agents:list` (agent list snapshots and updates), `workspaces:list` (workspace list snapshots and updates),
  `attention:inbox` (Home), `kanban:board` (the board), `runs:list` (runs), and `agent-graph:trees` (the agent
  graph).
- Modules add their own WebSocket routes with `host.sockets.add(path, open)`, under `/api/<module id>/`. `open`
  gets the path params and throws an ApiError to refuse the upgrade with its status. Every upgrade, `/api/ws`
  included, passes `guardRequest` (Host, Origin, peer, and login; section 13, Remote access) and needs the user's
  token in `?token=` (browsers cannot set headers on a
  WebSocket). Agent tokens are never accepted. `ApiClient.socketUrl(path)` builds the URL in the page.
- Routes under `/api/bridge/` are for spore-bridge and take only agent tokens; all others take only the user's token
  (ADR 0032). Card routes (ADR 0100): `GET /api/bridge/cards?label=&column=`, `GET /api/bridge/cards/:id` (one card
  with its body; a read-only token may read), `POST /api/bridge/cards`, `POST /api/bridge/cards/:id` (change), and
  `POST /api/bridge/cards/:id/start` (files an approval). The mutating
  ones refuse a read-only side chat with 403 `read_only_chat`.
- CLI for approvals: `pi-spore approvals list [--all]`, `pi-spore approvals approve <id>`, `pi-spore approvals
  decline <id> [--note text]`.
- `POST /api/bridge/reports` takes a stage agent's `report` (section 8), read-only callers included.
- `POST /api/bridge/workspace/pr` `{ title, body }` files a `workspace-pr` approval through the requester github-pr
  sets (section 11e); without one it is 422 `not_supported`.
- `POST /api/bridge/workspace/push` `{}` pushes the caller's workspace branch with the VCS `publish` push, which never
  forces, and answers `{ remote, line }`. It refuses a read-only chat (403 `read_only_chat`), a run's coordinator
  (403 `run_coordinator`), and a workspace without its own branch of a Git project (422 `not_supported`). A
  rejected push is 409 `push_failed`.
- Run routes for spore-bridge are in section 9.
- CLI for jobs: `pi-spore jobs [--all]` (id, kind, state, step, error), `pi-spore jobs retry <id>`, `pi-spore jobs
  cancel <id>`.
- `GET /api/health` returns status, version, uptime, and enabled modules. Store status is added with the store.
- The CLI (`pi-spore`) reads `~/.pi-spore/token` and calls the API. Agents use spore-bridge instead. Its server
  address is `PI_SPORE_URL`, else `http://127.0.0.1:$PI_SPORE_PORT`, else `http://127.0.0.1:7420`.
- The CLI also runs the server (ADR 0184). These commands run local programs through `CliDeps.system.run`, with argv
  and no shell; tests fake it. `CliDeps.system.capture` is the same with stdout and stderr captured into one string,
  for the program whose output must not reach the terminal.
  - `pi-spore start [--open]`: the server in the foreground, with the CLI's Node.
  - `pi-spore service install [--yes]` writes `~/.config/systemd/user/pi-spore.service` after it shows the unit and
    the user says yes, then runs `systemctl --user daemon-reload` and `enable --now pi-spore`. The unit has the
    absolute path of a Node 26 (`.nvmrc`), a PATH with the folders of that Node, `pi` (required), `git`, `gh`, and
    `unity`, the `PI_SPORE_HOME` and `PI_SPORE_PORT` of the shell, and an optional
    `EnvironmentFile=-%h/.config/pi-spore/service.env`. It has `After=` and `WantedBy=graphical-session.target`, so
    the server gets the desktop's `DISPLAY` and the Unity editor can open a window (ADR 0191). Over an existing unit,
    install runs `systemctl --user disable pi-spore` first, to drop the old enable link. `service uninstall [--yes]`
    disables and removes it.
  - `pi-spore open` (`xdg-open`), `pi-spore logs [-f]` (`journalctl --user -u pi-spore`). The opener runs through
    `capture`: its output is dropped on success and the last five non-empty lines go in the error when it fails,
    because desktop openers such as KDE's log noise that reads like a pi-spore failure.
  - `pi-spore restart` and `pi-spore rebuild [--install]`: before `systemctl --user restart pi-spore`, they read
    `GET /api/agents` and ask y/N when a chat is busy, starting, or has helpers running. `rebuild` runs `npm ci`
    (only with `--install`) and `npm run build` first, with the npm of the unit's Node; a failed build stops before
    the restart.
  - The repo folder comes from the CLI's own file, not the current folder. `service`, `restart`, and `logs` need
    Linux with systemd.
- `pi-spore remote [--json]` prints the `tailscale serve` command, the URLs, and the allowed logins, or the
  settings to add when remote access is off. It runs nothing (ADR 0143).
- Chats (agents module, ADR 0030):

  | Route | Does |
  |---|---|
  | `GET /api/agents/models` | The models Pi offers, `{ models }`, for the start dropdowns when no chat runs (ADR 0120). Starts a short-lived Pi process that counts against `agents.maxLive`; cached for 60 s. 502 `models_unavailable` if Pi fails or answers badly. A model listed in `tiers` in `settings.json` has its router `tier`. The tiers are read on each call, not cached. If `settings.json` is bad, the models still list without tiers, and `tierError` names the problem. |
  | `GET /api/agents/role-models` | Each role and subagent type with its default model from Pi's `settings.json` (ADR 0181, section 13). 409 `pi_settings_not_json` or `pi_settings_shape` for a file pi-spore cannot read. |
  | `PUT /api/agents/role-models/:name` | Sets `{ model }` or removes `{ unset: true }` that name's `agentOverrides.<name>.model`, and answers the new list (ADR 0181). 422 `unknown_model`, 404 `unknown_role`. |
  | `GET /api/agents/:id/models` | The chat's models and thinking levels, `{ models, thinkingLevels }`, asked of its Pi process. Models get `tier` and the answer gets `tierError` the same way as above. |
  | `GET /api/agents?workspaceId=` | The workspace's chats: the active orchestrator chat, side chats, then older orchestrator chats, newest first in each group. |
  | `POST /api/agents` `{ workspaceId, model? }` | The active orchestrator chat; the first call creates it (201), on `model` when given (ADR 0120). |
  | `POST /api/agents/chats` `{ workspaceId, kind, fork?, model? }` | Starts an orchestrator chat (replaces the active one, on `model` when given) or a side chat; `fork` copies the orchestrator chat's context. |
  | `POST /api/agents/:id/activate` | Makes an older orchestrator chat the active one; the current one stops first. |
  | `POST /api/agents/:id/title` `{ title }` | Renames a chat. |
  | `POST /api/agents/:id/close` | Closes a chat for good (ADR 0110). 409 `chat_busy` while it works. |
  | `POST /api/agents/:id/prompt` `{ message, images?, whileBusy? }` | Sends a message; `images` are `{ mimeType, data }` in base64 (below). |
  | `GET /api/agents/:id/images/:ref` | The bytes of an image block the chat has shown (below). |
  | `GET /api/agents/:id/linked-image?path=` | An image file the agent linked, from the workspace folder or its artifacts folder only (below). |
  | `GET /api/agents/:id/children/:runId/transcript?child=` | A helper run's task, messages, and output, read from the agent's process (section 2, Helpers). |

  The `agent:<id>` topic sends `{ type: "agent", agent }` when a chat's title or active flag changes.
- Images in the chat (ADR 0060, R5.1):
  - A message may carry PNG, JPEG, WebP, or GIF images: at most 8, each at most 10 MiB decoded, with bytes that
    match their type (settings `agents.maxImagesPerMessage` and `agents.maxImageBytes`). They go to Pi
    as `ImageContent` blocks with the prompt, steer, or follow-up. A message may be only images. Models list what
    they take (`input`), so the composer warns when the chat's model takes no images; Pi then sends a placeholder.
  - Image blocks never reach the page as data. In every Pi event the server relays and every message it reads from
    a session file, `data` becomes `ref` (the SHA-256 of the base64) and `bytes`. Pages fetch the bytes by ref with
    the token header and show them as blob URLs. Decoded bytes stay in a memory cache (64 MiB, `imageCacheBytes`);
    a dropped one is read from the session file again. A chat reads only refs it has shown.
  - `linked-image` resolves the path against the workspace folder, resolves symlinks, and answers only for a regular
    file inside the workspace folder or `artifacts/workspaces/<id>/`, whose real name has an image extension, of at
    most `maxImageBytes`, with bytes that match the extension. Anything else is 400, 403, 404, 413, or 415, and the
    page shows the plain link.
  - The page shows image blocks as thumbnails with a full-size viewer. In Markdown, an image or a link to a local
    image path goes through `linked-image`; a remote image loads only after a click, without a referrer (ADR 0061);
    any other link stays plain.
  CLI: `pi-spore chat list <workspace>`, `pi-spore chat new <workspace> [--side [--fork]]`.

## 16. Open questions

See [open-questions.md](open-questions.md).
