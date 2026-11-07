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
- Launch arguments: `--session <path>` (or `--session-dir` for a new one), `--model`, `--thinking`, `--tools` for
  read-only roles, `--no-extensions` plus one `-e` per extension from the user's setup minus
  `agents.excludeExtensions` (ADR 0025), `-e <repo>/pi-extensions/spore-bridge`, and `--append-system-prompt <role prompt file>`. The cwd
  is the workspace directory.
- Env given to each agent (the server's env minus `ORCA_*` and `HERDR_*`): `PI_SPORE_URL`, `PI_SPORE_TOKEN` (scoped to this agent), `PI_SPORE_AGENT_ID`,
  `PI_SPORE_WORKSPACE_ID`, `PI_SPORE_RUN_ID` (in a run), `PI_SPORE_UNITY_PROJECT` (Unity projects), and the
  workspace action env.
- Transcripts are Pi session JSONL files in `~/.pi-spore/sessions/<workspace id>/`. They can still be opened in the
  CLI with `pi --session <path>`.
- Extension dialogs (`extension_ui_request`) become pending prompts on the chat and on Home. The answer goes back as
  `extension_ui_response`. Dialogs with a timeout resolve on their own as Pi defines.
- **spore-bridge** (`pi-extensions/spore-bridge/`) is a Pi extension that adds the workbench tools and reports
  agent state to the server over HTTP:
  - `request_human_input`: outside a run, files a question to the user.
  - `ask_coordinator`: inside a lane, files a question to the coordinator.
  - `report`: the structured stage result (verdict, findings, artifacts).
  - `kanban_add_card`, `kanban_update_card`.
  - `run_action`: run a project action.
  - `check`: run the project's `check` action and return its errors (ADR 0025).
  - Coordinator only: `start_lane`, `answer_lane`, `merge_lane`.
  - Questions do not block the tool. The tool files the question and ends the turn. The answer arrives later as a
    new message, so a long wait survives restarts.
- A process is started when an agent has work and stopped when it is idle for a while or its workspace is parked.
  Restarting it with `--session` restores the conversation.
- Spike Q1 ([notes](spikes/q1-rpc-agents.md)) confirmed the full setup loads in RPC mode. Rules from it:
  - Agent env drops `ORCA_*` and `HERDR_*`, so agents do not report into the terminal that started pi-spore.
  - Pi hangs when a session's stored working folder is gone. Before `--session`, pi-spore checks that folder.
    Archived transcripts are read from the session file directly, without starting Pi.
  - Every agent start has a timeout. On timeout, pi-spore stops the process and shows its stderr.
  - Agents run without pi-lens and get a `check` tool instead (ADR 0025).
- Limits: at most 4 live agent processes; an idle agent process stops after 10 minutes (ADR 0026).

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
  api: ApiClient;                         // HTTP and live events
  addPage(page: WebPage): void;           // a hash route; `rail` adds an icon to the left rail
  provide / use                           // as on the server
}

export interface ServerHost {
  settings: SettingsReader;               // resolved values with their source
  store: Store;                           // SQLite, module-owned tables via migrations
  jobs: JobRunner;                        // durable jobs (section 6)
  events: EventBus;                       // typed server events, pushed to the web over ws
  routes: RouteRegistrar;                 // Hono routes under /api/<module id>/
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

## 5. Domain model

| Entity | Meaning | Key fields |
|---|---|---|
| Project | A registered Git checkout or folder | id, name, path, vcs kind, detected traits (`unity`) |
| Workspace | One piece of work | id, project, name, slug, isolation, path, branch, state (active, parked, archived), card |
| Agent | One Pi conversation | id, workspace, role, model selection, session path, process state, parent agent |
| Run | A coordinator conversation that owns lanes | id, project, coordinator agent, integration branch, spec artifact, state |
| Lane | A workspace inside a run | id, run, workspace, wave, depends on, brief artifact, state |
| Pipeline | A declared stage list (file) | id, source (user or project), stages |
| PipelineRun | One pipeline execution on a workspace | id, workspace, pipeline id + content hash, current stage, state |
| Stage | One stage execution | id, pipeline run, name, round, agent, verdict, findings |
| Question | A question going up the chain | id, from agent, to (coordinator or user), body, answer, state |
| Approval | A decision gate on Home | id, kind (model upgrade, close editor, ...), subject, state |
| Card | A kanban card | id, project, column, title, body, labels, due, blocked by, workspace or run |
| EditorLease | Who holds the Unity editor of a project | project, worktree path, owner (user or agent), pid |
| RoutingDecision | One router choice | agent, target model, Jev answers, token estimate, usage snapshot, reason, outcome |
| UsageSnapshot | Latest plan window numbers | plan, window (5h, 7d), utilization, resets at, seen at, source |
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
- **Deliveries.** A question, answer, or lane result to an agent is a row. The runner delivers it when the agent is
  idle: start the process if needed, then send a prompt. If the agent is busy, the runner sends a follow-up. The row
  is marked done when Pi accepts it. No polling by agents.
- **Idempotency.** Mutating API requests carry an `Idempotency-Key`. The response is stored and replayed for a repeat
  of the same key.
- **Receipts.** Mutating spore-bridge tools send `(agent id, tool call id)` as the receipt key, so a replayed tool
  call returns the first result.
- This is weaker than Pi Durable in one place: a model turn cut off by a crash is not replayed token by token. Pi's
  session file keeps everything up to the last completed message, and the job decides how to continue.

## 7. VCS providers

See [ADR 0005](decisions/0005-vcs-providers.md).

```ts
export interface VcsProvider {
  kind: string;                                          // "git" | "folder"
  detect(path: string): Promise<boolean>;
  isolationModes(project: Project): IsolationMode[];     // e.g. new-copy, existing-line, in-place
  createWorkspace(project: Project, req: IsolationRequest): Promise<WorkspaceLocation>;
  removeWorkspace(loc: WorkspaceLocation): Promise<void>;
  changes(loc: WorkspaceLocation, scope: ChangeScope): Promise<ChangeSet>;
  diff(loc: WorkspaceLocation, scope: ChangeScope): Promise<Diff>;
  // Optional capabilities, detected by presence:
  lines?: LineOps;           // branches: list, create, merge into (git)
  record?: RecordOps;        // commit / stage (git)
  publish?: PublishOps;      // push + PR (git + gh)
}
```

- Words in the interface are neutral ("line" for branch, "record" for commit), so Perforce could fit later.
- Nothing outside a provider branches on `kind`.
- Providers run `git` and `gh` with `execFile`, never through a shell.
- New worktrees run the copy list (R2.6) and then the `setup` action.

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

See [ADR 0009](decisions/0009-model-routing.md) and [ADR 0010](decisions/0010-local-model-queue.md).

- `pi-extensions/router/` registers the virtual model `spore/auto` with `pi.registerVirtualModel`. It works in
  pi-spore and in plain `pi`.
- On the first user message of a session (`reason: "user"` with no router state):
  1. Estimate tokens: brief + named files + system prompt. If the estimate is above the local budget (default 50%
     of the local context window), route to cloud.
  2. Ask Jev (`typesafe/jev-latest`) choice questions about the prompt: is it bounded, are requirements explicit,
     is it visual, is the code change straightforward.
  3. Route to a local target only if every answer passes its threshold. Otherwise route to the cloud model for the
     role (default: the pi-subagents `worker` model).
  4. Store the choice as router state. The session stays on it for continuations and retries, to keep the prompt
     cache.
- Thresholds and Codex spill: ADR 0024.
- Escalation: when a local session hits a context overflow or fails the same gate twice, the router moves the
  session to the cloud model and records why.
- The decision, with Jev's probabilities and the estimate, goes to the server as a RoutingDecision. Outside
  pi-spore it is written to the session as an entry.
- Local targets are a list in settings: `{ model, contextWindow, budget, concurrency }`. Strata is
  `strata/qwen3.8-flash-next-unsloth-ud-iq2_xs`, 128k, concurrency 1. The coming larger server is one more entry.
- Queue: in pi-spore, the router asks the server for a slot on the target before the first local request. The
  session keeps the slot until its stage ends, so two sessions do not swap a 128k cache in and out. In plain `pi`, a
  lock file under `$XDG_RUNTIME_DIR/pi-spore/` does the same job.
- Strata start and stop stay with your `strata-model.ts`. The router does not manage the server.
- Usage pressure (R4.10): the router reads the latest usage snapshot (section 11a). Above the thresholds
  (weekly > 75% or 5-hour = 100%), it lowers the Jev confidence needed for local. It never relaxes the visual
  and context-fit checks. For roles pinned to a cloud model, the routing module posts a "switch to local
  implementer?" Approval instead of switching.
- Default pipelines set `tier = "route"` for `implement`, so the implementer is not the parent model (R4.9).

## 11a. Usage module

See [ADR 0022](decisions/0022-usage-tracking.md).

- Plan windows (5-hour, weekly, reset times):
  - Claude: pi-claude-bridge turns Claude Code's `rate_limit_event` into `anthropic-ratelimit-unified-*` headers
    on Pi's `after_provider_response` event. The built-in `anthropic` provider sends the same headers.
  - OpenAI Codex: source to confirm in the spike (**[Q11]**).
- A small usage tap reads those headers in every Pi process. It ships in the router extension, so plain `pi`
  sessions count too. It writes the latest snapshot per plan to `~/.pi-spore/usage/<plan>.json` (atomic rename).
  Inside pi-spore it also posts to the server.
- Headers arrive only when a request is made, so a snapshot can be old. Each snapshot has `seenAt`. The UI shows
  its age. The router ignores a snapshot older than its window's reset or older than a set limit.
- v1 is passive only (ADR 0022). Active polling of the plans' usage endpoints is a v2 option. It would also
  count use from Claude Code and the Codex CLI, which the tap cannot see.
- Token use per project, workspace, role, and model comes from the `usage` of assistant messages in Pi session
  files. pi-spore indexes its own sessions. It can also scan `~/.pi/agent/sessions/` for plain `pi` work.
- The Usage screen shows both. Home shows a warning when a window crosses a threshold.

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

See [ADR 0012](decisions/0012-kanban.md).

- Tables: `cards`, `card_links` (blocked by), `card_events` (history).
- Columns are fixed in v1: Backlog, Ready, In progress, Review, Done.
- Automatic moves:
  - start a workspace or run → In progress;
  - pipeline passed or PR open → Review;
  - PR merged or workspace archived as done → Done.
- Manual moves always win until the next state change.
- A blocked card shows its blockers. A workspace started from a blocked card asks first.
- Agents: `kanban_add_card` and `kanban_update_card` through spore-bridge. The CLI has `pi-spore card add|list|move`.

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
`beforeRemoveCopy` step answers 409 `<step>_failed` unless the archive is forced.

The workspace view has three panes: the workspace list (grouped active, parked, then archived behind a toggle,
newest activity first), the selected workspace's middle pane, and a right column with workspace details and module
panels. Routes: `#/workspaces` (list and the create form), `#/workspaces/in/<project>` (filtered to a project),
`#/workspaces/<id>` (one workspace). One component serves all three, so the list keeps its state. Other web modules
fill it through the workspaces web interface `WorkspaceViewKey`:

- `addPanel` adds a section to the right column (Actions, Unity). A panel renders its own `CollapsibleSection`, so
  it can render nothing when it does not apply.
- `setMain` sets the middle pane. The agents module sets the chat.
- `setStatus` sets a React hook that returns one status line per workspace. The agents module reads
  `GET /api/agents` on load, focus, and navigation, and every 5 s only while an agent is busy, starting, or
  waiting.

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
  logs/                  server, action, and agent stderr logs
```

## 15. API, events, CLI

- REST under `/api/<module>/...`, schemas in TypeBox, validated at the boundary.
- One WebSocket at `/api/ws` for server events (agent stream, job state, Home updates) and one per terminal.
- `GET /api/health` returns status, version, uptime, and enabled modules. Store status is added with the store.
- The CLI (`pi-spore`) reads `~/.pi-spore/token` and calls the API. Agents use spore-bridge instead.

## 16. Open questions

See [open-questions.md](open-questions.md).
