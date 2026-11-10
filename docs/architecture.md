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
  already loads it), and `-e <repo>/pi-extensions/spore-bridge` (the same way). The cwd is the workspace directory.
  pi-spore's rules come from spore-bridge, not from a prompt file (ADR 0031).
- Env given to each agent (the server's env minus `ORCA_*` and `HERDR_*`): `PI_SPORE_URL`, `PI_SPORE_TOKEN` (this
  process's agent token, ADR 0032), `PI_SPORE_SERVER_PID` (the server's pid, for the bash guard, ADR 0160), `PI_SPORE_AGENT_ID`, `PI_SPORE_WORKSPACE_ID`, `PI_SPORE_CHAT_KIND` (`worker` or
  `side`), `PI_SPORE_UNITY_PROJECT` (Unity projects), and from launch hooks `PI_SPORE_RUN_ID` and `PI_SPORE_RUN_ROLE`
  (`coordinator` or `lane`, section 9). Later: the workspace action env.
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
    always comes from the role default. A resumed session keeps its own model. An existing chat keeps its model, so
    `activeWorker` ignores `model` when the workspace already has one.
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
  - Title: the first user message, cut to 60 characters, set on the first prompt. Chats from before titles take it
    from their history when first read; side chats never take it from the copied history. The user can rename.
- **Stage agents** (R6, [ADR 0140](decisions/0140-pipeline-stage-agents.md)). A pipeline runs each stage on its own
  agent: kind `stage`, with a role (`worker`, `reviewer`, or `adversarial-reviewer`), a title (`implement`,
  `Review 1`, ...), and a fixed model. They show as chat tabs after side chats. A busy, starting, or waiting stage
  agent sets the workspace's status line (section 13).
  - `AgentsKey.createStage(workspaceId, { role, title, model? })` inserts the row and starts nothing, so the
    pipelines module commits it with the `deliver` that starts it. `roleDefaults(role)` reads
    `subagents.agentOverrides.<role>`; `modelsUsed(agentId)` lists the physical models Pi recorded on the agent's
    assistant messages; `sessionRoles(workspaceId)` lists the session file and role of each agent that has a session,
    so the `usage` module can split token use per role.
  - The thinking level comes from the role default. Env adds `PI_SPORE_CHAT_KIND=stage` and `PI_SPORE_STAGE_ROLE`.
  - Reviewer roles are read-only like side chats: `--tools read,grep,find,ls,request_human_input,artifacts_list,
    artifacts_read,report,ask_coordinator` (spore-bridge registers `ask_coordinator` only in a lane),
    `--exclude-tools 'mcp__*'`, and a read-only token. A stage `worker` has Pi's normal tools.
  - The model cannot change (`POST /api/agents/:id/model` answers 409 `stage_model_fixed`; the chat has no model
    picker), because the pipeline judges a reviewer by the model it ran on (R4.4). A stage whose agent failed gets a
    fresh agent on Retry instead (section 8, "Failed turns").
  - `turnError(agentId)` says why the agent's last run failed: the error of a `failed` status, or the
    `errorMessage` of the last assistant message when Pi ended the turn with `stopReason: "error"` (a provider that
    refused, such as a full usage window). `rename(agentId, title)` sets the title.
- Transcripts are Pi session JSONL files in `~/.pi-spore/sessions/<workspace id>/`. They can still be opened in the
  CLI with `pi --session <path>`.
- Extension dialogs (`extension_ui_request`) become pending prompts on the chat and on Home. The answer goes back as
  `extension_ui_response`. Dialogs with a timeout resolve on their own as Pi defines.
- **spore-bridge** (`pi-extensions/spore-bridge/`, package `@pi-spore/spore-bridge`) is a Pi extension that adds
  the workbench tools. It calls the `bridge` module's routes (`/api/bridge/`) with `PI_SPORE_URL` and the agent
  token (ADR 0032). A failed call reaches the model as a tool error that quotes the server.
  - `request_human_input` `{ question, choices?, recommended? }`: files a question for the user (Home) and ends the
    turn with `terminate: true`. The answer arrives later as a new user message, through a delivery (section 6), so
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
    lists the project's active workspaces), `kanban_add_card` and `kanban_update_card` (title, body, column, labels,
    due day, `blockedBy` card ids, `model`), and `kanban_start_card` `{ cardId, reason, workspaceId? | isolation?, line?,
    base? | run?, base? }`. The start tool files a `card-start` approval on Home and ends the turn with `terminate: true`; the
    decision comes back as a new user message. Without `workspaceId` the target is a new workspace with isolation
    `new` unless another is given; `run: true` asks for a new run. A run's coordinator gets only the list and add
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
    never from the request. A read-only side chat may list and read; a write answers 403 `read_only_chat`.
  - Every run of the agent replaces the global `AGENTS.md` in the prompt with pi-spore's rules (ADR 0031). Side
    chats (`PI_SPORE_CHAT_KIND=side`) get side chat rules instead (ADR 0033). Stage agents get stage worker or stage
    reviewer rules: end every turn with `report`, and record fail-first proofs. The stage worker runs `check`, then
    the full `run_action test`, before every `report`, and puts both results in it, so a break shows up before the
    reviewers, not at the final gates. The orchestrator rules say to start
    every subagent with `async: true`, because a foreground child does not load the chat's extensions (ADR 0120),
    and to send each slice of feature code through the workspace pipeline, not a `worker` subagent (ADR 0162).
  - `start_pipeline` `{ brief, pipeline?, name? }`, only in the orchestrator chat (`worker` kind, no run role; ADR 0162):
    posts `POST /api/bridge/pipelines` with the tool call id as receipt and ends the turn with `terminate: true`.
    The run's end arrives later as a message (section 8). `start_pipeline`, `start_lane`, and `revise_lane` read a
    brief artifact, so they are registered with `executionMode: "sequential"`. Pi then runs every tool call of that
    assistant message one by one, in order, so an `artifacts_write` of the brief earlier in the same message is done
    first. The rules also say to call them in a later message than the write.
  - `report` `{ turn, summary, verdict?, findings?, tests? }`, only in stage agents (R6.7): ends a pipeline turn with
    `terminate: true` through `POST /api/bridge/reports` (open to read-only reviewers). Reviewers give a verdict
    (`approve`, `revise`) and findings (`blocking`, `important`, `minor`); the worker lists each new test with the
    artifact path of its failing run. For a reviewer's REVISE with findings but none blocking, the tool first asks
    the Jev classifier (`router.classifier`, through `ctx.modelRegistry.classify`) whether another round is worth
    it, and adds `earlyStop: { stop, probability }` (stop at P >= 0.7), or `{ stop: false, error }` when the
    classifier fails (ADR 0140).
  - Run tools (R7, ADR 0150), by `PI_SPORE_RUN_ROLE`. The coordinator gets `start_lane` `{ name, brief, wave,
    dependsOn?, pipeline?, model? }`, `revise_lane` `{ laneId, brief }`, `merge_lane` `{ laneId }`, and
    `answer_lane` `{ questionId, answer }`, and coordinator rules in place of the orchestrator rules. Of the card
    tools it gets only `kanban_list_cards` and `kanban_add_card` (ADR 0154). A lane agent
    gets `ask_coordinator` `{ question }` in place of `request_human_input`; it files the question and ends the turn
    with `terminate: true`. Lane agents get one more paragraph of rules: ask the coordinator, never the user.
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
  helpers show under it in the chat.
  - Source: the `subagent-async` widget that pi-subagents sets in RPC mode, a `PI_SUBAGENT_ASYNC_JSON:` line with a
    version 1 snapshot of the agent's own session. `modules/agents/src/child-runs.ts` validates it (the one place
    that knows its format). A payload it does not understand is logged, shown as one chat notice, and the list stays
    as it was. Run files and `pi.events` are not used.
  - A child run is a top-level run of the snapshot with its steps: label, state, current tool, and per step the
    agent, model, and thinking level. Only a change of these is published, as `{ type: "children", children }` on
    the `agent:<id>` topic; the snapshot event carries the list too. The list empties when the process exits.
    Foreground helpers run inside the worker's process and stay the worker's running `subagent` tool call.
  - Each run in state `running` counts against `agents.maxLive` with the agent processes. It makes a new agent wait
    for a slot but never stops a run that exists. A queued run counts nothing. An agent with a running helper does
    not stop for idleness, and the Stop button of the chat is disabled.
  - The agent view carries `helpersRunning`, the count of `running` runs, left out when 0. A change of the count is
    an `AgentChange` of kind `helpers`, so `agents:list` and Home follow it. An idle chat with a running helper shows
    as working: "Working (helper running)" in the workspace list and on Home, `working (helper running)` in the chat
    header. It is not done; its process gets the helper's result.
  - Another module can mark an agent as working for something with `Agents.setWorkingFor(agentId, label)`, for
    example a chat that waits on a pipeline run. The label is `workingFor` on the agent view, in memory only, and a
    change of it is an `AgentChange` of kind `working`. `undefined` clears it. It never touches `waitingSince`.
    An idle or stopped chat with `workingFor` shows as working: Home has a running item with status `pipeline` and
    the label as its detail, and no `finished` item; the workspace line is `Working (<label>)`, and the chat header
    `working (<label>)`. A wait for the user and a failed agent still win. The pipelines module sets the label
    for the chat of each `running` run.
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
  cli/          pi-spore CLI over the HTTP API
modules/<id>/   one npm package per module, @pi-spore/mod-<id>
  src/server.ts server entry: exports the ServerModule and any interface keys and types
  src/web.tsx   web entry: exports the WebModule (pages)
  src/*.test.ts tests, run against server-core's test server
pi-extensions/
  spore-bridge/ workbench tools for agents (loaded with -e)
  router/       router virtual model; also installable into plain pi
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
  move into the top bar, controls are at least 44 px tall, and fields use 16 px text. A page that shows one pane
  at a time keeps the open pane in the hash, `#/<path>?pane=<name>`; the router ignores the query. `openPane`,
  `switchPane`, and `closePane` change it, and Back closes a pane. The root follows `visualViewport` so the
  composer stays above the on-screen keyboard. Hover-only controls also show with `touch:` (`@media (hover:
  none)`). `packages/web/public` holds the web app manifest and icons. At 768 px and above nothing changes.
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
| Workspace | One piece of work | id, project, name, slug, isolation, path, branch, base (what a new branch started from), state (active, parked, archived), archived at, card |
| Agent | One Pi conversation (a chat) | id, workspace, role (`orchestrator`), kind (worker, side), active, closed, closed at, title, forked from, model selection, session path, process state, parent agent |
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
  asked for, else the main checkout's branch, else its commit.
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
[ADR 0016](decisions/0016-fail-first-proof.md), [ADR 0140](decisions/0140-pipeline-stage-agents.md),
[ADR 0158](decisions/0158-revise-lane-is-a-fix-pass.md), and [ADR 0162](decisions/0162-orchestrator-starts-pipeline-runs.md).
Requirements R6, R4.4, R4.9.

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
rounds = 1
fix_passes = 1            # a REVISE on the last round gets one fix, with no review after it

[[stage]]
name = "gates"
gates = ["check", "test"] # action names from config.toml
fail_first = "artifact"   # every new test needs its proof artifact (ADR 0016)
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
gates = ["check", "test"]
fail_first = "artifact"
```

- Checks: unknown keys, keys of the other stage kind, and bad values are 422 `bad_pipeline` naming the file. The
  first stage, and only it, is the `worker` stage. A stage sets `model` (`provider/id`) or `tier`, or neither (the
  role default). Only `tier = "route"` is built; other tiers are an error that says so. `model` is refused in
  project files (R17.3). `worker = "reuse"` is allowed only on the worker stage, and not with `model` or `tier`.
  `rounds` defaults to 1, `fix_passes` (0 or 1) to 0. A per-stage thinking level is not
  built (R6.1); it comes from the role default.
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
- **Stage jobs.** Each stage is a `pipelines.stage` job keyed by the workspace. Steps: `advance` (start the next
  turn), `await` (wait for its report), `decide` (apply the verdict), `gate`, and `finish` (start the next stage's
  job in the same commit, or end the run `passed`). A turn's row, its stage agent, and the prompt's delivery commit
  together. Prompts name the turn on a `Turn: <id>` line, and the brief is the workspace artifact
  `pipelines/<run>/brief.md`. A worker's task prompt also holds the brief's full text under `## Brief`, so
  `spore/auto` scores the real task on a new worker's first message (ADR 0144).
- **Reports.** The bridge passes `report` calls to `PipelinesKey.report`. Only the turn's agent may report (403
  `not_your_turn`), once per turn (a repeat returns the stored turn; an older turn is 409 `turn_closed`). Reviewers
  must give a verdict and no tests; the worker gives no verdict. Worker tests join the run's manifest by name, so a
  later report never drops a test.
- **Restarts** (R6.6). The `await` step keeps the server's boot id in its checkpoint. After a restart it sees another
  one and tells the agent once to continue and call `report`. There are no other automatic reminders.
- **Failed turns** (ADR 0140). The pipeline listens to the stage agents' status. When the open turn's agent fails
  (`turnError`: a crash, or a turn that ended with `stopReason: "error"`), the `await` step throws
  `stage <name>: the <role> agent "<title>" failed: <error>. Retry starts a fresh <role> agent for this turn.` The
  job waits with that error, so the run stays `running` and shows it as `blocked`. The old agent may still report
  while the run is blocked. Retry (`POST /api/pipelines/runs/:id/retry`) writes the error on the turn, and `await`
  then replaces it in one commit: the old agent is renamed `<title> (failed)` and keeps its tab, and a fresh agent
  takes the turn. A task or review turn goes back to `advance`, so the round number stays and `min_strength_over`
  is checked again; a fix turn goes to a fresh worker with the same findings, and the run's worker becomes it. The
  fresh agent has the stage's or run's model, else the role default read when it starts, so a settings fix works.
  A restart or another wake does not mark the turn, so it only blocks again. Retry also works while such a wake runs
  the blocked step again: it marks the turn and wakes the job, so the step runs once more after it settles. Failed
  turns do not count as rounds.
- **Review rounds** (R6.3, R6.4). Round r starts a fresh reviewer with the brief, the manifest with proof paths, and
  a diff artifact `pipelines/<run>/<stage>-<r>.diff` (commits since the base, then uncommitted and untracked files,
  from the provider's `changes`). From round 2 on, the prompt also has the previous round's summary and findings and
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
- **Working label.** While a run is `running`, the pipelines module marks its chat with `Agents.setWorkingFor`, so
  Home does not show the chat as done: `Pipeline: <stage>`, with `, round <n>` from round 2 of a review stage, or
  `Pipeline: <n> runs` for a coordinator with lanes. The chat is the lane's coordinator, else the asking chat. A
  `waiting_user` or ended run gives no label. The module syncs it at every `publish`, at boot, and when the runs
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
- **Gates** (R6.5, ADR 0016). With `fail_first = "artifact"`, each test in the manifest needs a non-empty proof
  artifact, or the run fails with `missing fail-first proof for <test>` before any action runs. Then each gate
  action runs once through `ActionsKey.start(..., "pipeline", { key })` with the key `<run>:<stage>:<action>:<attempt>`,
  so a step that runs again gets the same action run back. A run a restart cut off starts once more under the next
  attempt. A failure ends the run `failed` with the last 4 KiB of its log. The message has no color codes and lists
  the failed vitest tests (up to 10) above the log. The failing tests are never run again.
  A gate action that config.toml does not declare blocks the run with the stage, the action, and the config.toml
  path to fix.
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
| `POST /api/pipelines/runs/:id/retry` | Runs the run's waiting step now (409 `run_not_waiting`). A turn whose agent failed gets a fresh agent. |
| `POST /api/pipelines/runs/:id/cancel` | Stops a run. |

- Topic `pipelines:<workspace id>` sends `{ type: "runs", runs }` on subscribe and after every change.
- Web: a Pipeline tab (after PR) with a start form (pipeline, optional name, brief) when no run is active, and the
  runs, newest first. Only the newest run is open; an older run shows its header and step bar until clicked. A run
  shows a header line (the name, then the pipeline id as a chip, or the pipeline id alone; source, state, elapsed
  time, Cancel), a step bar with each stage's state and counts (a click scrolls to the stage), the notices
  (message up to `GATE_LOG_HEADING`, so a gate failure shows its headline and failed tests; `blocked` with Retry),
  and a numbered timeline: every turn by `createdAt`, plus a Gates row that holds a failed gate's log in a closed
  block, ANSI codes removed. A fix row belongs to the worker stage. Each row is one line (kind and
  round, verdict, finding counts, model, duration) and opens to the summary, findings by severity (minor closed),
  tests with proofs, the route, Jev's answer, and a link to the agent's chat. Only the newest or running row is open
  at first; the user's open and close choices stay when new data comes. A Details panel shows the latest run and its
  open findings.
- CLI: `pi-spore pipeline list <workspace>`, `pipeline start <workspace> <pipeline> (--brief <text> | --brief-file
  <path>) [--name <text>]`, `pipeline runs <workspace>`, `pipeline show <run>` (both print the name when set),
  `pipeline cancel <run>`, `pipeline retry <run>`.
- Other modules use `PipelinesKey`: `start(workspaceId, { pipeline, brief, name?, askingAgentId?, workerModel? })` does what
  the start route does; `workerModel` sets the worker stage's model for that run only (column `worker_model`), so
  that run never asks about the local implementer.
  `afterRunEnded(listener)` runs for every run that ends, inside the transaction that ends it. The `usage` module
  uses it to record outcomes (section 11a). `onChange(listener)` runs with the workspace id whenever its runs
  change, as the topic does; the runs module uses it to show a lane's `blocked`.
- Not built yet: tiers other than `route`, a thinking level per stage, a brief preset from the card, and moving the
  card when a run passes.

## 9. Runs and lanes

See [ADR 0007](decisions/0007-coordinator-runs.md), [ADR 0008](decisions/0008-questions-up-the-chain.md),
[ADR 0014](decisions/0014-lane-model-approval.md), [ADR 0017](decisions/0017-integration-branch.md),
[ADR 0150](decisions/0150-run-worktree-and-green-merges.md), [ADR 0151](decisions/0151-run-cancel-handover-and-pr-approval.md),
[ADR 0154](decisions/0154-coordinator-adds-cards.md), [ADR 0157](decisions/0157-finished-run-follows-the-active-chat.md), and
[ADR 0165](decisions/0165-finished-run-pushes-each-merge.md). Requirements R7, R4.8.

The `runs` module (not core, requires `projects`, `workspaces`, `agents`, `artifacts`, `attention`, `actions`,
`pipelines`) owns `runs_runs`, `runs_lanes`, and `runs_questions`. The bridge requires it.

- **Start.** `POST /api/runs` `{ projectId, name, base?, gates?, settings? }` needs a provider with `integrate` (else 422
  `not_supported`). `base` defaults to the main copy's current line; `gates` to `check` and `test`. It creates
  `run/<slug>-<last 6 of the run id>` at the base, the **run workspace** on it (isolation `existing`, with the base
  stored, so its PR tab targets the base), and its orchestrator chat. That chat is the coordinator. `settings` is
  the run's settings override (section 13); the run workspace and every lane workspace get it, with source `run`.
- **Coordinator.** A launch hook gives a `worker`-kind chat in a run workspace `PI_SPORE_RUN_ROLE=coordinator` and
  the allowlist `read,grep,find,ls,request_human_input,artifacts_list,artifacts_read,artifacts_write,
  kanban_list_cards,kanban_add_card,start_lane,revise_lane,merge_lane,answer_lane,open_run_pr,run_status`: no write or shell
  tools. Its token is not read-only, so it writes artifacts and calls the run routes. Every agent in a lane workspace
  gets `PI_SPORE_RUN_ROLE=lane`.
- **Follow-up cards** (ADR 0154). The coordinator adds a card for follow-up work out of the lanes' scope; it never
  changes or starts one. A card added from a run workspace goes to `backlog` with the label
  `from-run:<slug of the run name, up to 31 characters>`; the bridge sets both. A card change or start from a run
  workspace answers 403 `run_coordinator`. Lane agents keep all four card tools.
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
  - States: `approval`, `waiting`, `starting`, `running`, `passed`, `failed`, `declined`, `merging`, `merged`,
    `cancelled`.
- **Merge** (ADR 0150). `merge_lane` takes a `passed` lane (409 `lane_not_mergeable`), makes it `merging`, and
  starts job `runs.merge`, keyed by the run, so merges go one at a time. `merge` aborts any merge a restart left,
  then merges the lane line into the run worktree without a commit. A conflict aborts, puts the lane back to
  `passed`, and sends the files to the coordinator. `gate` runs each run gate on the merged tree through
  `ActionsKey.start` with a key per merge job and attempt. `finish` commits when all passed (`merged`, wakes waiting
  lanes); on a red gate it writes the diff to `runs/<run>/lanes/<lane>-gates.diff`, aborts, puts the lane back to
  `passed`, and sends the diff path and the last 4 KiB of the log. The run line only holds merges whose gates passed.
  When every lane is `merged` or `declined`, the coordinator of a `running` run is told to call `open_run_pr`. In a
  `finished` run, `finish` pushes the run line after the commit with the VCS `publish` push, never forced, so the
  open PR shows the merge (ADR 0165). The message says so and never names `open_run_pr`. A failed push leaves the
  lane `merged`, and the message gives the error and says the PR does not show the merge.
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
  title, body, base, and head (the run line), and the tool ends the turn. On approve, where the user may edit the
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
  `{ type: "runs", runs }` on subscribe and after every change.
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
     Explore (ADR 0144): when "straightforward" is the only rung-1 blocker, the session is a pipeline worker stage
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
  notice replaces earlier `info` notices, so one shows; `warning` and `error` notices stay, up to 5. The model
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
  agent, workspace, question, choices, recommended, state `open`, `answered`, or `closed`, answer, times).
  `recommended` is the index of the choice the agent recommends. It is advice only: Home shows that choice with the
  primary style and a "Recommended" chip, and `pi-spore inbox` marks it `(recommended)`. Filing it without `choices`,
  or with an index past the last choice, is 400 `bad_recommended`. A question closes when
  its orchestrator chat stops being the active one; answering it then is 409 `question_closed` (ADR 0033). The bridge module files them
  through `QuestionsKey`.
- `POST /api/attention/questions/:id/answer` `{ answer }` stores the answer and queues it for the agent through
  `AgentsKey.deliver`, in one transaction. A second answer is 409 `question_answered`. The agent gets a message that
  names the question, the question text, and the answer.
- `GET /api/attention/inbox` and topic `attention:inbox` give the inbox. The topic sends the whole inbox on subscribe
  and after every change (at most once per tick). It has:
  - Every item names its chat (`chat`: id, title, kind, active) and links to `#/workspaces/<id>/chats/<chat>`.
  - `items`, newest first: open questions; open extension dialogs of running agents; failed agents with their error;
    agents whose last run ended and that wait for the user (`finished`), unless they have an open question or a
    running helper. Pipeline stage agents are never `finished`: their pipeline reads the report and moves on. `notice` items
    come from other modules' sources (below). A notice has no chat: it has `source`, `id`, `title`, optional `detail`, and
    an `href` to the module's page.
  - `running`: agents that are busy, starting, or waiting for a slot, and idle agents with a running helper
    (`status: "helpers"`). When the helper ends, an idle agent that waits for the user is `finished` again.
- The agents module tracks what Home needs (`AgentsKey.attention()`): when each agent entered its status, when each
  dialog opened, and `waiting_since` on `agents_agents`. `waiting_since` is set when a run settles without an abort,
  and cleared when the user sends a message, opens the chat, the chat page sees the run end while it is visible, or
  the user dismisses it (`POST /api/agents/:id/seen`). Statuses and dialogs live in memory; after a restart every
  agent is stopped.
- The Home page (`#/`, attention web module) shows the items as cards: a question with its choices and a text
  answer; the same dialog card as the chat (from the agents web interface `AgentsWebKey`); a failure with its error;
  a finished agent with Open chat and Dismiss. The inbox also has `interrupted`: jobs a restart cut off (section
  6), read through `host.jobs` and shown as "Interrupted work" with Retry and Cancel. Running work is a short list
  below. The Home rail icon shows the count of items and interrupted jobs through `RailItem.useBadge`.
- The chat page shows its own open questions and approvals above the composer, so the user need not go to Home. The
  agents web interface has `AgentsWebKey.addChatPanel(id, component)`: the chat page renders each added component,
  given the chat's id, above the composer of an active chat. With none added, the chat looks as before. The attention
  web module adds one. It reads the same `attention:inbox` store as Home, keeps the items of this chat with
  `chatAsks(inbox, chatId)` (open questions and approvals, in inbox order), and renders them with Home's
  `QuestionCard` and approval views. An answer is the same call from both places, and the inbox update removes the
  item from both. Failures, finished work, and dialogs stay as they were (dialogs show in the chat already). An older
  worker chat, a side chat, or a workspace that is not active shows no panel; their questions are closed (ADR 0033).
- The workspace list shows "Waiting for your answer" (tone `warn`) for a workspace whose active worker chat has an
  open question, approval, or dialog and is idle or stopped. The agents web interface has
  `AgentsWebKey.setUserWaits(hook)`: a React hook that returns, per chat id, why that chat waits for the user
  (`question`, `approval`, or `dialog`). The attention web module sets it from the same `attention:inbox` store, with
  `chatWaits(inbox)`. With no hook set, the list looks as before.
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
  but not focused, each new item shows a notification. Items already there when the page loads do not. Phone
  browsers show notifications only from a service worker, which pi-spore does not have, so the button hides on
  phones (ADR 0159). A notification that fails to show logs one warning and the inbox goes on. The browser's
  permission is the only switch; pi-spore has no notification setting (ADR 0167).
- Toasts (R15.2): while the page has focus, each new item shows an in-page toast instead (`showToast` and
  `Toaster` in `packages/ui`, mounted once in `App.tsx`). One item gives a toast or a notification, never both;
  `notifyItem` in the attention web module makes that choice. Toasts show only on desktop screens
  (`(hover: hover) and (pointer: fine)`), and not for an item whose chat is the open page, because that page shows
  its own asks. A toast has the item's title and body, an Open link to the same place as on Home, and a close
  button. It closes after 8 seconds, and hover pauses that. At most 3 show at once.
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
- The CLI reads the same route: `pi-spore inbox list` prints each item and each running agent with an id, its kind
  (`question`, `approval`, `dialog`, `failed`, `finished`, `running`, `notice`), age, `project / workspace`, and the
  chat link. `pi-spore inbox show <id>` prints one in full: a question's text and choices, an approval's gate, title,
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

See [ADR 0090](decisions/0090-changes-and-pull-requests.md). Requirements R8.

- The `changes` module (not core, requires `projects`, `workspaces`, `agents`) reads a workspace's changes through
  its provider's `changes` capability (section 7). Projects without it (folders) answer 422 `not_supported`; a
  workspace whose folder is gone answers 409 `folder_missing`.
- The base for `line` is the workspace's recorded base, else the provider's default base; without either, 409
  `no_base`.
- Limits (module options): 1000 files in a list, 200 files with hunks in a diff without `path`, and 3000 lines or
  512 KiB per file. A larger or binary file has a `note` (`too_large`, `binary`) and no hunks.
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
| `GET /api/changes/workspaces/:id` | Scopes, base, and the records since the base (100), or the last 50 records without one. |
| `GET /api/changes/workspaces/:id/files?scope=&record=` | Changed files with status and counts. `scope`: `uncommitted` (default), `staged`, `line`, `record` (needs `record=<id>`). |
| `GET /api/changes/workspaces/:id/diff?scope=&record=&path=` | Hunks of one changed file, or of every file up to the limit; `truncated` says it cut. A path without changes is 404 `file_not_changed`. |
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
  they follow the theme; each side of a hunk is colored as one block. Binary and large files show a note.
- Each diff line has a comment button (shown on hover and keyboard focus). Comments show under their line; the
  bar at the bottom lists them with Add to composer and Send now. The tab reloads on Refresh, on a scope change, and on the
  `stale` event.
- The module adds a chat panel (`AgentsWeb.addChatPanel`) above the composer of an orchestrator chat. It shows the
  staged comments with a count, Drop on each, and Drop all. It follows the `changes:<workspace id>` topic. The socket sends the first snapshot to the first listener of a topic only, so the panel
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
  conflicts were sent), `github_pr_sent` (bot comments already sent), and
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

## 11. Unity module

See [ADR 0011](decisions/0011-unity-support.md).

- Detection: `ProjectSettings/ProjectVersion.txt`. Adds traits `unity` and the editor version.
- Worktree copy defaults: `Library/`, `*.csproj`, `*.sln`, with `cp --reflink=auto`. Warns when
  `Temp/UnityLockfile` exists in the main checkout.
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
- API under `/api/unity`: `GET /workspaces/:id` (Unity or not, the editor version, open editors, stale lock
  files, the lease, and `tests`: the last 5 gate runs with mode, status, and the report path), `POST /workspaces/:id/open`, `POST /editors/close` `{ projectId, path, confirm: true }`. The
  workspace view has a Unity panel for Unity projects.
- unity-mcp per worktree: the relay accepts `--project-path`. Agents get `PI_SPORE_UNITY_PROJECT=<worktree>`, and
  `~/.unity/relay/unity-mcp.sh` passes it on when set (ADR 0011).
- A Unity project's pipeline lists the test gates in a gate stage, for example
  `gates = ["check", "unity-test-editmode"]`. The Unity panel shows the last gate runs: mode, status, and the report
  artifact. The log of a run is in the Actions panel.

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
  workspace of the card's project; a parked one is 409 `workspace_not_active`, another project's 422
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
  - workspace or run started from the card → In progress;
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

Not built yet:

- Router keys in the Settings page. The router extension reads and checks its own `router` and `tiers` sections.

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
`beforeRemoveCopy` step answers 409 `<step>_failed` unless the archive is forced. `afterStateChange` runs after
every park, resume, and archive; a listener that throws is logged and does not undo the change. `create` makes a
workspace as `POST /api/workspaces` does, for modules that start work, such as kanban.

The workspace view has three panes: the workspace list (grouped by project, sorted by name, then active, parked,
and archived behind a toggle, newest activity first), the selected workspace's middle pane, and a right column with workspace details and module
panels. Routes: `#/workspaces` (list and the create form), `#/workspaces/in/<project>` (filtered to a project),
`#/workspaces/<id>` (one workspace). One component serves all three, so the list keeps its state. The list
follows the topic `workspaces:list`: a snapshot of every workspace on subscribe and after a reconnect, then one
`workspace` event for each create, rename, park, resume, and archive, wherever it came from. An active or parked
row shows an archive button on hover or keyboard focus. It asks first, as the Details archive does. Other web modules
fill it through the workspaces web interface `WorkspaceViewKey`:

- `addPanel` adds a section to the right column (Actions, Unity). A panel renders its own `CollapsibleSection`, so
  it can render nothing when it does not apply.
- `addTab` adds a tab after Details (Terminals). A `wide` tab widens the column while it is open. Its component
  mounts only while the tab is open.
- `setMain` sets the middle pane. The agents module sets the chat. The route `#/workspaces/<id>/chats/<chat>`
  passes `chatId`; without it the pane shows the active orchestrator chat.
- `setStatus` sets a React hook that returns one status line per workspace. The agents module subscribes to
  `agents:list`, which sends a snapshot on subscription and updates as chats are created or change. Reconnection
  supplies a fresh snapshot. A busy, starting, or waiting stage agent of the workspace wins first: "Working:
  <title>" (tone `run`), or "Waiting for a free agent slot" (tone `warn`), since the worker chat of a pipeline or a
  run lane sits stopped while stages work. A stage that works beats one that waits. An idle, stopped, or failed
  stage agent never shows. Otherwise the status line follows the active orchestrator chat. When that chat is idle or
  stopped and waits for the user (`AgentsWebKey.setUserWaits`, section 11b), the line says "Waiting for your
  answer". Otherwise an idle chat with a running helper (`helpersRunning`, section 2) says "Working (helper
  running)", tone `run`. A busy chat whose router waits for a local model shows its `routerStatus` ("Waiting for
  <model>", section 10), tone `warn`.
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
  `attention:inbox` (Home), `kanban:board` (the board), and `runs:list` (runs).
- Modules add their own WebSocket routes with `host.sockets.add(path, open)`, under `/api/<module id>/`. `open`
  gets the path params and throws an ApiError to refuse the upgrade with its status. Every upgrade, `/api/ws`
  included, passes `guardRequest` (Host, Origin, peer, and login; section 13, Remote access) and needs the user's
  token in `?token=` (browsers cannot set headers on a
  WebSocket). Agent tokens are never accepted. `ApiClient.socketUrl(path)` builds the URL in the page.
- Routes under `/api/bridge/` are for spore-bridge and take only agent tokens; all others take only the user's token
  (ADR 0032). Card routes (ADR 0100): `GET /api/bridge/cards?label=&column=`, `POST /api/bridge/cards`,
  `POST /api/bridge/cards/:id` (change), and `POST /api/bridge/cards/:id/start` (files an approval). The mutating
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
- The CLI (`pi-spore`) reads `~/.pi-spore/token` and calls the API. Agents use spore-bridge instead.
- `pi-spore remote [--json]` prints the `tailscale serve` command, the URLs, and the allowed logins, or the
  settings to add when remote access is off. It runs nothing (ADR 0143).
- Chats (agents module, ADR 0030):

  | Route | Does |
  |---|---|
  | `GET /api/agents/models` | The models Pi offers, `{ models }`, for the start dropdowns when no chat runs (ADR 0120). Starts a short-lived Pi process that counts against `agents.maxLive`; cached for 60 s. 502 `models_unavailable` if Pi fails or answers badly. A model listed in `tiers` in `settings.json` has its router `tier`. The tiers are read on each call, not cached. If `settings.json` is bad, the models still list without tiers, and `tierError` names the problem. |
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
