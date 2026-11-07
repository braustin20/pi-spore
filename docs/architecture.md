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
  process's agent token, ADR 0032), `PI_SPORE_AGENT_ID`, `PI_SPORE_WORKSPACE_ID`, `PI_SPORE_CHAT_KIND` (`worker` or
  `side`), and `PI_SPORE_UNITY_PROJECT` (Unity projects). Later: `PI_SPORE_RUN_ID` (in a run) and the workspace action env.
- **Chats** (ADR 0030, ADR 0033). An agent is one chat: one row in `agents_agents` with a `kind` (`worker` or
  `side`), an `active` flag, a `title`, and `forked_from` (the worker chat a side chat copies).
  - A workspace has one active worker chat (a partial unique index). Only it and side chats can run; an older worker
    chat is read-only history and refuses to start with 409 `chat_inactive`. The manager also refuses to start a
    worker chat while another worker chat of the workspace has a live process (409 `worker_running`).
  - New chat: the active worker chat becomes inactive, its process stops (its session file stays), and a new active
    worker chat starts empty. Make active works the same way for an older chat. Both refuse with 409 `worker_busy`
    while the current worker chat is busy, starting, or waiting for a slot. Chat changes of one workspace run one at
    a time.
  - A chat that becomes inactive drops its Home items: its failure, its finished mark, and its open questions, which
    are closed (ADR 0033). Pending deliveries to it wait until it is active again.
  - Side chats: any number, next to the worker, counted against `agents.maxLive` like any agent. They start empty,
    or with `--fork` from a copy of the active worker chat's session on their first start (409 `nothing_to_fork`
    when the worker chat has no session yet). The copy keeps the worker's model. After that first start the page
    gets a new snapshot with the copied messages.
  - Side chats are read-only through their tools: `--tools read,grep,find,ls,request_human_input` and
    `--exclude-tools 'mcp__*'` (ADR 0033). Their bridge token is read-only, so bridge routes that run commands refuse
    it, and spore-bridge gives them their own rules.
  - Title: the first user message, cut to 60 characters, set on the first prompt. Chats from before titles take it
    from their history when first read; side chats never take it from the copied history. The user can rename.
- Transcripts are Pi session JSONL files in `~/.pi-spore/sessions/<workspace id>/`. They can still be opened in the
  CLI with `pi --session <path>`.
- Extension dialogs (`extension_ui_request`) become pending prompts on the chat and on Home. The answer goes back as
  `extension_ui_response`. Dialogs with a timeout resolve on their own as Pi defines.
- **spore-bridge** (`pi-extensions/spore-bridge/`, package `@pi-spore/spore-bridge`) is a Pi extension that adds
  the workbench tools. It calls the `bridge` module's routes (`/api/bridge/`) with `PI_SPORE_URL` and the agent
  token (ADR 0032). A failed call reaches the model as a tool error that quotes the server.
  - `request_human_input` `{ question, choices? }`: files a question for the user (Home) and ends the turn with
    `terminate: true`. The answer arrives later as a new user message, through a delivery (section 6), so a long wait
    survives restarts. Its guidelines say to use the user's `ask_user` only for a quick choice while the user watches.
  - `check`: runs the project's `check` action and returns its outcome and log tail (ADR 0025).
  - `run_action` `{ name }`: runs a named project action the same way.
  - Both start the run, follow it with `GET /api/bridge/runs/:id?wait=25000` until it ends, then read the last
    16 KiB of its log. An aborted tool call cancels the run.
  - Card tools (ADR 0100), limited to cards of the agent's project: `kanban_list_cards` `{ label?, column? }` (also
    lists the project's active workspaces), `kanban_add_card` and `kanban_update_card` (title, body, column, labels,
    due day, `blockedBy` card ids), and `kanban_start_card` `{ cardId, reason, workspaceId? | isolation?, line?,
    base? }`. The start tool files a `card-start` approval on Home and ends the turn with `terminate: true`; the
    decision comes back as a new user message. Without `workspaceId` the target is a new workspace with isolation
    `new` unless another is given.
  - Every run of the agent replaces the global `AGENTS.md` in the prompt with pi-spore's rules (ADR 0031). Side
    chats (`PI_SPORE_CHAT_KIND=side`) get side chat rules instead (ADR 0033).
  - Not built yet: `ask_coordinator` (inside a lane), `report` (the structured stage result), and the coordinator's
    `start_lane`, `answer_lane`, `merge_lane`.
- A process is started when an agent has work and stopped when it is idle for a while or its workspace is parked.
  Restarting it with `--session` restores the conversation.
- Spike Q1 ([notes](spikes/q1-rpc-agents.md)) confirmed the full setup loads in RPC mode. Rules from it:
  - Agent env drops `ORCA_*` and `HERDR_*`, so agents do not report into the terminal that started pi-spore.
  - Pi hangs when a session's stored working folder is gone. Before `--session`, pi-spore checks that folder.
    Archived transcripts are read from the session file directly, without starting Pi.
  - Every agent start has a timeout. On timeout, pi-spore stops the process and shows its stderr.
  - Agents run without pi-lens and get a `check` tool instead (ADR 0025).
- Limits: at most 4 live agent processes; an idle agent process stops after 10 minutes (ADR 0026). Running
  background helpers count as live processes in the 4 (ADR 0034).
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
  - `GET /api/agents/:id/children/:runId/transcript?child=<step id>` sends `/subagents-inspect-rpc` to the agent's
    process (it runs even during a turn) and returns the `subagent-inspect` reply as `{ transcript }`. 404
    `child_not_found` for a run not in the list or an agent that is not running, 400 `bad_child_id` for an id with
    characters other than letters, digits, and `: _ . -`, 503 when pi-subagents does not answer in 10 s or fails.
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
  settings: SettingsReader;               // resolved values with their source
  store: Store;                           // SQLite, module-owned tables via migrations
  jobs: JobRunner;                        // durable jobs (section 6)
  events: EventBus;                       // typed server events, pushed to the web over ws
  routes: RouteRegistrar;                 // Hono routes under /api/<module id>/
  sockets: SocketRoutes;                  // WebSocket routes under /api/<module id>/ (section 15)
  provide<T>(key: InterfaceKey<T>, impl: T): void;  // export an operation or interface
  use<T>(key: InterfaceKey<T>): T;                  // only keys of modules in `requires`
  log: Logger;
}
```

- One plain-list registry in `packages/server/src/modules.ts` and one in `packages/web/src/modules.ts`.
- The web shell has a top bar (theme menu, server status dot), a left rail, and the page area. A page with
  `rail: { order, icon }` gets a rail icon, lit on its path and every path below it. Full pages wrap their content
  in `Page` from `@pi-spore/ui`; the workspace view fills the area itself.
- `server-core` holds everything except the registry, so module tests can use its test server without a package
  cycle (server → modules → server-core).
- Startup validation, each failure stops the server with a clear message:
  - ids are unique;
  - every required module is present and enabled;
  - core modules are not disabled;
  - the dependency graph has no cycle.
- Setup runs in dependency order.
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
| Workspace | One piece of work | id, project, name, slug, isolation, path, branch, base (what a new branch started from), state (active, parked, archived), card |
| Agent | One Pi conversation (a chat) | id, workspace, role, kind (worker, side), active, title, forked from, model selection, session path, process state, parent agent |
| Run | A coordinator conversation that owns lanes | id, project, coordinator agent, integration branch, spec artifact, state |
| Lane | A workspace inside a run | id, run, workspace, wave, depends on, brief artifact, state |
| Pipeline | A declared stage list (file) | id, source (user or project), stages |
| PipelineRun | One pipeline execution on a workspace | id, workspace, pipeline id + content hash, current stage, state |
| Stage | One stage execution | id, pipeline run, name, round, agent, verdict, findings |
| Question | A question going up the chain | id, from agent, to (coordinator or user), body, answer, state |
| Approval | A decision gate on Home (ADR 0100) | id, kind (`card-start`; later model upgrade, close editor), asking agent, workspace, title, reason, subject, state (open, approved, declined), outcome |
| Card | A kanban card | id, project, column, position, title, body, labels, due, blocked by, workspace, created by and changed by (agent) |
| EditorLease | Who holds the Unity editor of a project | project, worktree path, owner (user or agent), pid |
| RoutingDecision | One router choice (a line in `usage/routing.jsonl`, not a table) | kind, route, model, reasons, Jev answers, token estimate, plan windows seen, session, agent, workspace |
| UsageSnapshot | Latest plan window numbers (a file per plan, `usage/<plan>.json`) | plan, window (5h, 7d), utilization, resets at, seen at, source |
| Job | A durable unit of background work | id, kind, state, input, checkpoint, attempts, lease |

## 6. Persistence and durability

See [ADR 0004](decisions/0004-state-in-sqlite.md).

- One SQLite file, `~/.pi-spore/data/pi-spore.sqlite`, through `node:sqlite`. It is built into Node, so there is
  no native module to build. It supports FTS5 for the v2 search.
- A lock file next to it. A second server refuses to start.
- Each module owns its tables and ships numbered migrations.
- **Jobs.** Pipeline stages, PR watching, lane starts, and deliveries are jobs:
  - A job runs as named steps.
  - Each step commits a checkpoint in the same transaction as its effects on the store.
  - After a restart, the runner picks up running jobs from their last checkpoint.
  - A step that was cut off while it waited on an agent turn asks the agent process to continue its session. If
    that is unsafe, it marks the stage `interrupted` and asks the user on Home.
- **Deliveries.** A question, answer, or lane result to an agent is a row in `agents_deliveries`, written through
  `AgentsKey.deliver` in the same transaction as the change that causes it (answering a question writes the answer
  and the delivery together). The agents module sends it as a prompt: it starts the process if needed, and sends a
  follow-up if the agent is busy. The row is marked `done` when Pi accepts it. No polling by agents.
  - Pending rows are tried again on server start, when the agent becomes idle, and when its workspace is resumed.
    A parked or archived workspace keeps its rows. A failed try records the error and stays pending.
  - Delivery is at least once: a crash between Pi's accept and the `done` write sends the message again.
  - Deliveries do not use the job runner yet; it does not exist. They move to it when it lands.
- **Idempotency.** Mutating API requests carry an `Idempotency-Key`. The response is stored and replayed for a repeat
  of the same key. Server errors (5xx) are not stored, so a retry runs again.
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

## 8. Pipelines

See [ADR 0006](decisions/0006-declared-pipelines.md).

Pipeline files are TOML (one parser for all config). `~/.pi-spore/pipelines/<id>.toml` and
`<project>/.pi-spore/pipelines/<id>.toml`. A project file with the same id wins.

```toml
id = "default"

[[stage]]
name = "implement"
role = "worker"
tier = "route"            # use the router; "heavy" | "medium" | "light" pick a role tier

[[stage]]
name = "review"
role = "reviewer"
fresh = true              # new read-only agent each round
rounds = 2                # hard limit of review → worker rounds
early_stop = "jev"        # Jev may stop early when only minor findings remain
min_strength_over = "implement"   # must be stronger than the model that implemented

[[stage]]
name = "adversarial"
role = "adversarial-reviewer"
fix_passes = 1

[[stage]]
name = "gates"
gates = ["check", "test"] # action names from config.toml
fail_first = "artifact"   # reviewer-checked proof (ADR 0016)
```

- A PipelineRun stores the content hash of the file it started with. Edits apply to new runs only.
- Each stage is a job. A review round is one step: start a fresh reviewer, send the diff and brief, wait for the
  `report` tool, store the verdict.
- `min_strength_over` enforces R4.4. If the implement stage ran on a local model, the review stage refuses any
  model that is not stronger. Model strength comes from the tier list in settings (ADR 0023).

## 9. Runs and lanes

See [ADR 0007](decisions/0007-coordinator-runs.md) and [ADR 0017](decisions/0017-integration-branch.md).

- A run creates the integration branch `run/<slug>-<id>` from the base branch and a coordinator agent in the main
  checkout (read-only on the working copy; it writes only through spore-bridge tools and artifacts).
- The coordinator writes the spec and lane briefs as artifacts, then calls `start_lane` per lane with wave and
  dependencies. pi-spore creates each lane's worktree from the integration branch and starts its pipeline when its
  wave is ready.
- Lane model approval (R4.8): `start_lane` with no model override starts at once. An override in a higher tier than the
  role default (ADR 0023) creates an Approval on Home and the lane waits.
- When a lane's pipeline passes, the coordinator reviews the diff and calls `merge_lane`. pi-spore merges the lane
  branch into the integration branch and re-runs the run's gates there. Conflicts go back to the coordinator.
- When all lanes are merged, the coordinator (or the user) opens one PR from the integration branch. The human
  merges.

## 10. Model routing

See [ADR 0009](decisions/0009-model-routing.md), [ADR 0010](decisions/0010-local-model-queue.md),
[ADR 0023](decisions/0023-model-tiers.md), and [ADR 0024](decisions/0024-routing-thresholds.md).

- `pi-extensions/router/` (package `@pi-spore/router`) registers the virtual model `spore/auto` with
  `pi.registerVirtualModel`. pi-spore agents load it with one more `-e` (section 2). Plain `pi` loads it with
  `pi -e <repo>/pi-extensions/router` or by adding the folder to Pi's `packages`.
- On a session's first request (no router state yet):
  1. Pick the first local target that is in Pi's model catalog.
  2. Estimate tokens at about 4 characters per token: the conversation so far (system prompt and brief) plus the
     size of every existing file the brief names. Above the target's budget (default 50% of its context), the task
     goes to cloud and Jev is not asked.
  3. Ask the classifier (`router.classifier`, default `openrouter/~typesafe/jev-latest`) four choice questions about
     the brief: bounded, explicit requirements, visual, straightforward.
  4. Go local only if every "good" answer is at least the threshold (0.7, or 0.55 under usage pressure; the visual
     question always needs 0.7). Otherwise use the cloud model: `router.cloud`, else the pi-subagents `worker`
     model from Pi's settings.
  5. If the cloud model's plan is full, spill (below).
  6. Store the choice as router state on the session branch. Later requests stay on it, to keep the prompt cache.
     Requests outside the agent loop (`direct`, such as compaction) go to the model that answered last.
- Escalation: a local session moves to the cloud model at once on a context overflow, or on the second failed
  request in a row. A `queue_wait_timeout` error (Strata busy, spike Q3) does not count as a failure.
- The router never crashes a session. If it fails itself (bad settings, missing model), it routes to the cloud
  model, pins the session there, records `kind: "error"` with the message, and shows a warning.
- Every decision is appended to `~/.pi-spore/usage/routing.jsonl`: time, kind (`initial`, `escalation`, `error`),
  route (`local`, `cloud`, `spill`, `wait`), model, reasons, Jev's good-answer probabilities, the estimate and budget,
  the threshold, the plan windows it saw, and the session id, file, and folder. Inside pi-spore it also has the agent
  and workspace ids. The chat shows each decision as a notice. The router state on the session holds the route and
  reasons too.
- Local targets are a list in settings: `{ model, contextWindow, budget, concurrency, healthUrl? }`. Default: Strata
  `strata/qwen3.8-flash-next-unsloth-ud-iq2_xs`, 131072 tokens, budget 0.5, concurrency 1, health URL
  `http://127.0.0.1:8080/health`. A second local server is one more entry.
- Queue (ADR 0010): a session routed local takes a slot through a lock file,
  `$XDG_RUNTIME_DIR/pi-spore/<target>.<n>.lock`, one per slot up to `concurrency`. The file holds the pid; a lock of a
  dead process is taken over. A busy target makes the request wait, with a "Waiting for <model>" status and notice.
  The slot is held for the agent run and freed on `agent_settled`, on session shutdown, and on escalation. The same
  files work in pi-spore and in plain `pi`. Without `XDG_RUNTIME_DIR` the router cannot lock and routes to cloud.
- Starting a local target: before the first local request of a run, the router emits `pi-spore:local-route` on
  `pi.events` with `{ provider, modelId, ctx, wait(promise) }`. The extension that runs the target starts it and passes
  its "ready" promise to `wait`; the router awaits it. The user's `strata-model.ts` does this for Strata. Then the
  router checks `healthUrl`. A failure frees the slot and routes to cloud. The router never starts or stops a server
  itself.
- Usage pressure (R4.10): the router reads the plan snapshots (section 11a). If the cloud model's plan has a fresh
  weekly window above 75% or a 5-hour window at 100%, it lowers the threshold. It never relaxes the visual and
  context-fit checks.
- Spill (ADR 0024): when a fresh window of the cloud model's plan is at 100% and the task does not go local, the
  router uses the first model in `router.spill` that is on another plan and in the same tier. A plan with no fresh
  numbers counts as having room; the reason says "usage unknown". If the spill plan is full too, the route is `wait`:
  the request ends with an error that names the first reset, and no state is stored, so the next message routes
  again.
- Not built yet: the "switch to local implementer?" Approval for roles pinned to a cloud model (Home approvals do not
  exist yet), and pipeline stages (`tier = "route"` for `implement`, R4.9).

### Router settings

In `~/.pi-spore/settings.json` (or `$PI_SPORE_HOME/settings.json`), read by the extension on each routing decision.
Built-in defaults apply to every key left out. Unknown `router` keys and wrong values are an error, which the router
records and routes to cloud.

```json
{
  "router": {
    "classifier": "openrouter/~typesafe/jev-latest",
    "cloud": "claude-bridge/claude-sonnet-5-5",
    "localTargets": [
      { "model": "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs", "contextWindow": 131072, "budget": 0.5,
        "concurrency": 1, "healthUrl": "http://127.0.0.1:8080/health" }
    ],
    "threshold": 0.7,
    "pressureThreshold": 0.55,
    "pressure": { "weekly": 0.75, "fiveHour": 1 },
    "usageMaxAgeMinutes": 60,
    "spill": ["openai/gpt-6-luna", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol"],
    "plans": { "claude-bridge": "claude", "anthropic": "claude", "openai": "codex", "openai-codex": "codex" }
  },
  "tiers": { "llama-cpp/qwen3.8-27b-m": "local" }
}
```

- `cloud` has no built-in default: unset means the pi-subagents `worker` model.
- `plans` maps a provider to the subscription plan it draws on. `tiers` entries are added to the built-in tier list
  (ADR 0023).

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
- v1 is passive only (ADR 0022). Active polling of the plans' usage endpoints is a v2 option. It would also
  count use from Claude Code and the Codex CLI, which the tap cannot see.
- The `usage` module (`modules/usage/`, not core, requires `projects` and `workspaces`) owns no tables. It reads the
  router's files on each request through `@pi-spore/router`, so file formats have one definition:
  - `GET /api/usage/plans`: each plan's windows with age and staleness, warnings, the thresholds, and plan files that
    did not read. A warning is a fresh window that is full, a weekly window above `router.pressure.weekly`, or a
    5-hour window at or above `router.pressure.fiveHour` (R18.4).
  - `GET /api/usage/tokens`: token use per project, workspace, and model, summed from the `usage` of every assistant
    message in `~/.pi-spore/sessions/<workspace id>/*.jsonl`. Sums are cached per file by size and modification
    time. Models in the `local` tier show as free (R18.2). Lines that are not JSON are counted, not fatal. A forked
    session (a side chat) skips the entries copied from its parent, which are older than its header, so they count
    once.
  - `GET /api/usage/routing?limit=<1-500>`: the newest routing decisions (default 50), and how many lines did not
    parse.
  - Wrong router settings answer 422 `bad_settings`.
- The Usage page (`#/usage`, rail icon) shows the plan windows with bars, reset times, age, and a stale chip; the
  warnings at the top; the token table; and the routing decisions with their reasons. It loads on open and on
  Refresh.
- Not built yet: token use per role (every agent is a worker today), scanning `~/.pi/agent/sessions/` for plain `pi`
  work, and a warning on Home (Home has no module slots yet).

## 11b. Home and questions (attention module)

See [ADR 0008](decisions/0008-questions-up-the-chain.md). Requirements R3.5, R5.6, R15.

- The `attention` module (core, requires `projects`, `workspaces`, `agents`) owns questions (`attention_questions`:
  agent, workspace, question, choices, state `open`, `answered`, or `closed`, answer, times). A question closes when
  its worker chat stops being the active one; answering it then is 409 `question_closed` (ADR 0033). The bridge module files them
  through `QuestionsKey`.
- `POST /api/attention/questions/:id/answer` `{ answer }` stores the answer and queues it for the agent through
  `AgentsKey.deliver`, in one transaction. A second answer is 409 `question_answered`. The agent gets a message that
  names the question, the question text, and the answer.
- `GET /api/attention/inbox` and topic `attention:inbox` give the inbox. The topic sends the whole inbox on subscribe
  and after every change (at most once per tick). It has:
  - Every item names its chat (`chat`: id, title, kind, active) and links to `#/workspaces/<id>/chats/<chat>`.
  - `items`, newest first: open questions; open extension dialogs of running agents; failed agents with their error;
    agents whose last run ended and that wait for the user (`finished`), unless they have an open question.
  - `running`: agents that are busy, starting, or waiting for a slot.
- The agents module tracks what Home needs (`AgentsKey.attention()`): when each agent entered its status, when each
  dialog opened, and `waiting_since` on `agents_agents`. `waiting_since` is set when a run settles without an abort,
  and cleared when the user sends a message, opens the chat, the chat page sees the run end while it is visible, or
  the user dismisses it (`POST /api/agents/:id/seen`). Statuses and dialogs live in memory; after a restart every
  agent is stopped.
- The Home page (`#/`, attention web module) shows the items as cards: a question with its choices and a text
  answer; the same dialog card as the chat (from the agents web interface `AgentsWebKey`); a failure with its error;
  a finished agent with Open chat and Dismiss. Running work is a short list below. The Home rail icon shows the item
  count through `RailItem.useBadge`.
- Desktop notifications (R15.2): a button asks for permission; the page never asks on load. While the page is open
  but not focused, each new item shows a notification. Items already there when the page loads do not.
- **Approvals** (ADR 0100): decision gates in `attention_approvals` (kind, asking agent, workspace, title, reason,
  subject as JSON, state `open`, `approved`, or `declined`, outcome, times). The module that owns a gate registers
  its kind through `ApprovalsKey.register({ kind, subject, approve })` and files approvals with
  `ApprovalsKey.file(caller, ...)`; the kind's TypeBox schema checks the subject both times. Open approvals are Home
  items (`kind: "approval"`); an agent with an open approval is not also shown as finished.
  - `GET /api/attention/approvals?state=` lists them, newest first; `GET /api/attention/approvals/:id` reads one.
  - `POST /api/attention/approvals/:id/approve` `{ subject? }` runs the kind's `approve` with the filed subject or a
    changed one, then stores the decision and delivers the outcome to the asking agent in one transaction. A throw
    leaves the approval open and answers with the error. A second approve while one runs is 409
    `approval_deciding`; a decided one is 409 `approval_decided`; a kind no enabled module handles is 409
    `approval_kind_unknown`.
  - `POST /api/attention/approvals/:id/decline` `{ note? }` stores the decline and delivers it with the note.
  - These routes take only the user's token, and no bridge route decides an approval, so an agent cannot approve
    its own request.
  - Home shows an approval with the view its kind's web module adds through `AttentionWebKey.addApprovalView`, or a
    plain one (title, reason, approve, decline with a note).
- Not built yet: usage warnings, and a CLI command for the inbox.

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
  code, body, created, sent). "Send to agent" writes one delivery to the workspace's active worker chat
  (`AgentsKey.deliver`) and marks the comments sent in the same transaction. Sent comments leave the open list. No
  worker chat yet is 409 `no_worker_chat`. The message lists each comment with its file, line, quoted code, and text.
- Topic `changes:<workspace id>` sends the open comments on subscribe and after each change
  (`{ type: "comments" }`), and `{ type: "stale" }` when a worker chat of the workspace ends a run, so an open tab
  reloads.

| Route | Does |
|---|---|
| `GET /api/changes/workspaces/:id` | Scopes, base, and the records since the base (100), or the last 50 records without one. |
| `GET /api/changes/workspaces/:id/files?scope=&record=` | Changed files with status and counts. `scope`: `uncommitted` (default), `staged`, `line`, `record` (needs `record=<id>`). |
| `GET /api/changes/workspaces/:id/diff?scope=&record=&path=` | Hunks of one changed file, or of every file up to the limit; `truncated` says it cut. A path without changes is 404 `file_not_changed`. |
| `GET /api/changes/workspaces/:id/comments` | Open comments. |
| `POST /api/changes/workspaces/:id/comments` `{ path, side, line, code, body }` | Adds a comment. |
| `DELETE /api/changes/comments/:id` | Deletes an open comment; a sent one is 409 `comment_sent`. |
| `POST /api/changes/workspaces/:id/comments/send` | Sends every open comment to the worker as one message. |

CLI: `pi-spore ws diff <workspace> [--staged | --commits | --commit <id>]` prints each file's status, path, and
counts, then its hunks in unified form.

- The web module adds a Changes tab (`WorkspaceView.addTab`, `wide`, before Terminals): a scope select
  (Uncommitted, Staged, "Branch since <base>", One commit with a commit select), the changed files with a status
  chip (A, M, D, R), a comment count, and `+`/`-` counts, then the selected file's diff. Unified or split view (a
  browser choice). Code colors come from lowlight (highlight.js grammars, `common` set), mapped to role tokens, so
  they follow the theme; each side of a hunk is colored as one block. Binary and large files show a note.
- Each diff line has a comment button (shown on hover and keyboard focus). Comments show under their line; the
  bar at the bottom lists them with Send to agent. The tab reloads on Refresh, on a scope change, and on the
  `stale` event.
- Not built yet: attaching comments to the chat composer so they go with the next message (R8.3). Today they go
  as their own message.

## 11e. Pull requests

See [ADR 0090](decisions/0090-changes-and-pull-requests.md). Requirements R9.

- The `github-pr` module (not core, requires `projects`, `workspaces`, `agents`, `kanban`) talks to GitHub only
  through `gh`, run with `execFile`, `GH_PROMPT_DISABLED=1`, and `--json` where gh has it. Output is checked with
  TypeBox; a value it does not know (a new check conclusion) is a 422 `gh_failed`, not a guess.
- The only gh commands it runs: `gh pr view <number|branch> --json ...`, `gh pr create --base= --head= --title=
  --body= [--draft]` (the `=` form keeps a title starting with `-` a value), `gh run view --job <id>
  --log-failed`, and `gh api --method=GET --paginate --slurp` for the PR's comments, reviews, and line comments.
  It never merges, closes, enables auto-merge, or force-pushes (R9.3). The tests fail on any other gh command.
- Publish (`confirm: true` required): pushes the branch through the provider's `publish` (section 7), opens the
  PR, stores it, turns the watch on, and moves the workspace's card to Review (`CardsKey.workChanged`). The form
  starts with the workspace name as title, the card's body as body, and the workspace's base. A base like
  `origin/main` loses its remote name.
- A PR opened outside pi-spore for the workspace's branch is found on `GET ...?refresh=1` and shown, with the watch
  off.
- Tables: `github_pr_prs` (one per workspace: number, the last view as JSON, watch state, tries, the head whose
  failures were sent, the last clean head, message, poll times), `github_pr_sent` (bot comments already sent), and
  `github_pr_tries` (each automatic message, for the tab).
- Watch (R9.2), a timer per watched PR; timers start again on server start and when a workspace resumes, and stop
  while it is parked or archived:
  - Each poll reads the PR. 30 s after a change (head, checks, mergeability), doubling to 5 min while nothing
    changes.
  - When no check on the head is pending, it reads the bot comments. If a check failed on a head not handled yet,
    or a bot left comments not sent yet, it sends one message to the active worker chat (`AgentsKey.deliver`):
    each failed check with its link and the last 80 lines (8 KiB) of its failed log (ANSI codes removed, at most 5
    logs), then the bot comments with file and line, then "commit and push again; do not force-push; do not merge".
    The delivery, the sent marks, and the try count commit in one transaction.
  - A bot is an account GitHub types `Bot` (Q14: their comments go to the worker; people's do not).
  - At most 3 tries in a row (module option). A head with every check passed and nothing to send ends the run. After
    3 tries, or with no worker chat, the watch is `waiting` with a message, and sends nothing until the user resumes
    (`watch on`), which starts a new run and sends the current failures again.
  - A merged PR moves the card to Done; a merged or closed PR ends the watch (`done`).
- Topic `github-pr:<workspace id>` sends the status on subscribe and after each poll.

| Route | Does |
|---|---|
| `GET /api/github-pr/workspaces/:id[?refresh=1]` | The status: publishable, form defaults, the PR, watch state and tries, the local head and uncommitted count. `refresh=1` asks GitHub first. |
| `POST /api/github-pr/workspaces/:id/publish` `{ title, body, base, draft?, confirm: true }` | Pushes and opens the PR (201). An open PR is 409 `pr_exists`. |
| `POST /api/github-pr/workspaces/:id/push` `{ confirm: true }` | Pushes new commits to the PR's branch. |
| `POST /api/github-pr/workspaces/:id/watch` `{ on }` | Turns the watch on (a new run of tries) or off. |

CLI: `pi-spore pr status <workspace>`, `pi-spore pr open <workspace> [--title t] [--body b] [--base branch]
[--draft]` (the form defaults fill what is not given), `pi-spore pr push <workspace>`, and `pi-spore pr watch
<workspace> on|off`.

- The web module adds a PR tab (after Changes) and a "Pull request" panel in Details. The tab asks GitHub on open
  (`refresh=1`) and follows the topic. Without a PR it shows the publish form (title, description, into branch,
  draft) and a warning about uncommitted files; "Push and open PR…" shows a confirm that names the branch and says
  the push is visible to others. With a PR it shows a header card (number, title, state, branch → base, review,
  conflicts), a Push… confirm when the workspace has commits the PR lacks, the checks with state chips and links,
  and the watch: state, tries, last and next look, the message, Resume and send again, Stop watching, and the tries
  so far. The Details panel shows the number, state, failing checks, conflicts, and "Waiting for you".
- Not built yet: "waiting for you" on Home (the attention module has no way for other modules to add items, Q18),
  and PR tools for agents (they come through spore-bridge).

## 11. Unity module

See [ADR 0011](decisions/0011-unity-support.md).

- Detection: `ProjectSettings/ProjectVersion.txt`. Adds traits `unity` and the editor version.
- Worktree copy defaults: `Library/`, `*.csproj`, `*.sln`, with `cp --reflink=auto`. Warns when
  `Temp/UnityLockfile` exists in the main checkout.
- Editor control through the `unity` CLI (run with `host.exec`, plus `--no-banner --non-interactive`):
  - `unity open <path>` to open (it returns at once);
  - `unity status --json` to see open editors, their project paths, and pids;
  - `unity close <path>` to close (exits without saving, so it is only run after an explicit yes);
  - `unity test --mode <EditMode|PlayMode> --output <artifact>` for gates (not built yet).
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
    editor was never seen counts as a starting editor for 10 minutes, then is dropped.
  - Archiving a workspace whose folder has an editor open fails with 409 `editor_open`, even with force.
  - Other modules use the `UnityEditorsKey` interface: `editors(projectId)`, `open(workspaceId, owner)`,
    `close(projectId, path)`.
  - Later: an agent that needs the editor (for unity-mcp work) creates an Approval and opens Unity only after a
    yes. If another agent holds the lease, it waits. If the user holds it, the Approval asks to share or close it.
  - Later: a batch-mode gate needs the editor of its worktree closed. It waits for an agent lease to end, or
    creates a "close Unity?" Approval for a user lease.
- API under `/api/unity`: `GET /workspaces/:id` (Unity or not, the editor version, open editors, stale lock
  files, the lease), `POST /workspaces/:id/open`, `POST /editors/close` `{ projectId, path, confirm: true }`. The
  workspace view has a Unity panel for Unity projects.
- unity-mcp per worktree: the relay accepts `--project-path`. Agents get `PI_SPORE_UNITY_PROJECT=<worktree>`, and
  `~/.unity/relay/unity-mcp.sh` passes it on when set (ADR 0011).
- Gates for Unity projects come from a project pipeline. The module ships an example with `unity test` EditMode
  gates.

## 12. Kanban

See [ADR 0012](decisions/0012-kanban.md) and [ADR 0040](decisions/0040-card-moves-on-workspace-state.md). Requirements
R11.

- The `kanban` module (`modules/kanban/`, not core, requires `projects`, `workspaces`, `agents`, and `attention`)
  owns three tables: `kanban_cards` (title, Markdown body, project, labels, due day, column, position, the workspace
  started from it, and the agent that created it and the one that changed it last),
  `kanban_links` ("blocked by": a card or a workspace), and `kanban_events` (each move between columns, with its
  reason).
- Columns are fixed in v1: Backlog, Ready, In progress, Review, Done. `position` orders a column from 0; every move
  renumbers the columns it touches.
- A blocker is open while its card is not in Done or its workspace is not archived. A card is blocked while any
  blocker is open. A card cannot block itself.
- Due dates are calendar days (`YYYY-MM-DD`). The board compares them with the browser's local day: a card in any
  column but Done is overdue after its day, and "due today" on it.
- Removing a project leaves its id on cards; the board shows "removed project".
- Starting work from a card (R11.4, ADR 0100): `POST /api/kanban/cards/:id/start` with either the create-workspace
  fields (a new workspace through `WorkspacesKey.create`, named after the card) or `{ workspaceId }` (an active
  workspace of the card's project; a parked one is 409 `workspace_not_active`, another project's 422
  `project_mismatch`). The card links to the workspace and moves to In progress, and in the same transaction its
  brief (title, labels, due day, blockers, notes) goes to the workspace's active worker chat through
  `AgentsKey.deliver`. `AgentsKey.activeWorker` creates that chat if the workspace has none. A busy worker gets the
  brief as a follow-up after its current run. A card with an open workspace answers 409 `card_has_workspace`. A
  blocked card answers 409 `card_blocked` unless the request carries `confirmBlocked: true`; the board asks the user
  first.
- Agents (ADR 0100) reach cards through `CardsKey` from the bridge module: cards of their own project only, with
  `createdBy` and `changedBy` set to the agent and its workspace. A change or move by the user clears `changedBy`.
  A move by an agent is recorded with reason `agent`. `CardsKey.requestStart` checks the card and target, then files
  a `card-start` approval (subject `{ cardId, target }`); approving it starts the work as above, with the target the
  user chose, and tells the asking agent where it started.
- Automatic moves happen only on a state change, so a manual move stays until the next one:
  - workspace started from the card → In progress;
  - workspace archived → Done (any archive; the user moves the card back if the work was dropped). The module
    listens with `WorkspacesKey.afterStateChange`.
  - Later modules move cards through `CardsKey.workChanged(workspaceId, column, reason)`: pipeline passed or PR
    open → Review, PR merged → Done.
- Runs are not built yet, so a card starts only workspaces.

API under `/api/kanban`:

| Route | Does |
|---|---|
| `GET /cards?projectId=&label=&workspaceId=` | Cards in board order. |
| `POST /cards` `{ title, body?, projectId?, labels?, due?, column?, blockedBy? }` | Adds a card at the end of its column (default Backlog). |
| `GET /cards/:id` | The card and its history of moves. |
| `PATCH /cards/:id` | Changes the fields given; `null` clears project or due. `blockedBy` replaces the list. |
| `POST /cards/:id/move` `{ column, index? }` | Moves or reorders. Without `index`, the card goes to the end. |
| `DELETE /cards/:id` | Deletes the card, its links both ways, and its history. |
| `POST /cards/:id/start` | Starts work from the card in a new or an existing workspace (above). |

- Topic `kanban:board` sends every card on subscribe and after every change.
- The Board page (`#/board`, `#/board/<card id>`, rail icon) shows the columns with a project and a label filter.
  Cards move by drag and drop, or with the move buttons on each card (keyboard). Selecting a card opens it on the
  right: edit, move, delete, blockers, history, and "Start a workspace" with the workspaces module's create form
  (`WorkspaceViewKey.CreateForm`). The workspace view has a Card panel for the workspace's card.
- The Work section offers "Start in a new workspace" (the create form) and "Start in an existing workspace" (the
  project's active workspaces). Cards made or changed by an agent show an agent chip, and the card panel names the
  agent's workspace with a link to its chat. Home shows a `card-start` approval with the card, whether it is
  blocked, the reason, and a target picker.
- CLI: `pi-spore card list [--project p] [--label l]`, `pi-spore card add <title> [--project p] [--due YYYY-MM-DD]
  [--label l] [--column c]`, `pi-spore card move <id> <column>`, `pi-spore card rm <id>`, `pi-spore card start <id>
  --new [--mode m] [--line b] [--base b] | --workspace <id> [--blocked-ok]`.
- Not built yet: runs from cards, custom columns, and overdue cards on Home (the attention module has no way for
  other modules to add items yet).

## 13. Settings

- Sources, later wins:
  1. built-in defaults;
  2. `~/.pi-spore/settings.json` (global);
  3. `<project>/.pi-spore/config.toml` (project file, may be committed);
  4. `<project>/.pi-spore/config.local.toml` (local override, gitignored);
  5. run or workspace override in the store.
- Every resolved value carries its source. The UI shows it. "Detected" values (Unity traits, editor version) come
  from modules.
- The project file is checked on load and must not contain model keys. Model choices live in Pi settings, global
  settings, or local overrides.

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

The workspaces module calls other modules around a copy through its contract: `afterCopyCreated` and
`beforeRemoveCopy` return step reports, which the create and archive responses list in `steps`. A failed
`beforeRemoveCopy` step answers 409 `<step>_failed` unless the archive is forced. `afterStateChange` runs after
every park, resume, and archive; a listener that throws is logged and does not undo the change. `create` makes a
workspace as `POST /api/workspaces` does, for modules that start work, such as kanban.

The workspace view has three panes: the workspace list (grouped active, parked, then archived behind a toggle,
newest activity first), the selected workspace's middle pane, and a right column with workspace details and module
panels. Routes: `#/workspaces` (list and the create form), `#/workspaces/in/<project>` (filtered to a project),
`#/workspaces/<id>` (one workspace). One component serves all three, so the list keeps its state. Other web modules
fill it through the workspaces web interface `WorkspaceViewKey`:

- `addPanel` adds a section to the right column (Actions, Unity). A panel renders its own `CollapsibleSection`, so
  it can render nothing when it does not apply.
- `addTab` adds a tab after Details (Terminals). A `wide` tab widens the column while it is open. Its component
  mounts only while the tab is open.
- `setMain` sets the middle pane. The agents module sets the chat. The route `#/workspaces/<id>/chats/<chat>`
  passes `chatId`; without it the pane shows the active worker chat.
- `setStatus` sets a React hook that returns one status line per workspace. The agents module reads
  `GET /api/agents` on load, focus, and navigation, and every 5 s only while an agent is busy, starting, or
  waiting. The status line follows the active worker chat.
- `CreateForm` is the "Start a workspace" form. Another module can fill in the name, lock the project, and send
  the request to its own route. The board uses it to start a workspace from a card.

## 14. Data layout

```text
~/.pi-spore/
  settings.json          global settings and disabled modules (projects live in the store)
  token                  API token (0600)
  data/pi-spore.sqlite   store (+ .lock)
  sessions/<workspace>/  Pi session JSONL files
  worktrees/<project>/<slug>-<id>/
  artifacts/<workspace>/
  pipelines/             user pipelines
  usage/<plan>.json      latest plan usage snapshots (written by the usage tap)
  usage/routing.jsonl    routing decisions (written by the router)
  logs/                  server, action, and agent stderr logs
```

## 15. API, events, CLI

- REST under `/api/<module>/...`, schemas in TypeBox, validated at the boundary.
- One WebSocket at `/api/ws` for server events and one per terminal. Topics: `agent:<id>` (one agent's stream),
  `attention:inbox` (Home), and `kanban:board` (the board).
- Modules add their own WebSocket routes with `host.sockets.add(path, open)`, under `/api/<module id>/`. `open`
  gets the path params and throws an ApiError to refuse the upgrade with its status. Every upgrade, `/api/ws`
  included, needs a loopback Host and Origin and the user's token in `?token=` (browsers cannot set headers on a
  WebSocket). Agent tokens are never accepted. `ApiClient.socketUrl(path)` builds the URL in the page.
- Routes under `/api/bridge/` are for spore-bridge and take only agent tokens; all others take only the user's token
  (ADR 0032). Card routes (ADR 0100): `GET /api/bridge/cards?label=&column=`, `POST /api/bridge/cards`,
  `POST /api/bridge/cards/:id` (change), and `POST /api/bridge/cards/:id/start` (files an approval). The mutating
  ones refuse a read-only side chat with 403 `read_only_chat`.
- CLI for approvals: `pi-spore approvals list [--all]`, `pi-spore approvals approve <id>`, `pi-spore approvals
  decline <id> [--note text]`.
- `GET /api/health` returns status, version, uptime, and enabled modules. Store status is added with the store.
- The CLI (`pi-spore`) reads `~/.pi-spore/token` and calls the API. Agents use spore-bridge instead.
- Chats (agents module, ADR 0030):

  | Route | Does |
  |---|---|
  | `GET /api/agents?workspaceId=` | The workspace's chats: the active worker chat, side chats, then older worker chats, newest first in each group. |
  | `POST /api/agents` `{ workspaceId }` | The active worker chat; the first call creates it (201). |
  | `POST /api/agents/chats` `{ workspaceId, kind, fork? }` | Starts a worker chat (replaces the active one) or a side chat; `fork` copies the worker chat's context. |
  | `POST /api/agents/:id/activate` | Makes an older worker chat the active one; the current one stops first. |
  | `POST /api/agents/:id/title` `{ title }` | Renames a chat. |
  | `POST /api/agents/:id/prompt` `{ message, images?, whileBusy? }` | Sends a message; `images` are `{ mimeType, data }` in base64 (below). |
  | `GET /api/agents/:id/images/:ref` | The bytes of an image block the chat has shown (below). |
  | `GET /api/agents/:id/linked-image?path=` | An image file the agent linked, from the workspace folder or its artifacts folder only (below). |
  | `GET /api/agents/:id/children/:runId/transcript?child=` | A helper run's task, messages, and output, read from the agent's process (section 2, Helpers). |

  The `agent:<id>` topic sends `{ type: "agent", agent }` when a chat's title or active flag changes.
- Images in the chat (ADR 0060, R5.1):
  - A message may carry PNG, JPEG, WebP, or GIF images: at most 8, each at most 10 MiB decoded, with bytes that
    match their type (module options `maxImagesPerMessage` and `maxImageBytes` until settings land). They go to Pi
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
