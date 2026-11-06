# pi-spore: Vision and Requirements

pi-spore is a single-user, local agent workbench. It runs Pi coding agents across many Git projects (Unity games
first) and makes the worker → reviewer → adversarial reviewer flow durable, enforced, and visible. It replaces the
current setup: Orca terminals, hand-made worktrees, setup scripts per repo, and prompt templates that nothing
enforces.

Requirements are numbered so decisions and code can cite them (`R3.2`). "v2" marks work that is designed for but
not built in v1.

## R1. Product shape

- R1.1 A local server, a browser UI, and a thin CLI (`pi-spore`). One user. No accounts, no hosting.
- R1.2 The server binds to `127.0.0.1` only and requires a token that the CLI and the UI read from
  `~/.pi-spore/`.
- R1.3 pi-spore replaces Orca for agent and Unity work: worktrees, setup, terminals, Unity launch, agent status.
- R1.4 Every agent is a Pi agent that loads the same auth, models, settings, skills, extensions, prompt templates,
  AGENTS.md files, and MCP config as the `pi` CLI. Extensions that work in `pi` today (Strata auto-start,
  claude-bridge, pi-subagents, pi-mcp-adapter, pi-lens) work unchanged in pi-spore.
- R1.5 Features beyond a small core are modules in this repo with a typed contract (see architecture).
- R1.6 State survives a server restart: workspaces, runs, pipeline stages, questions, approvals, cards, and
  transcripts. Work that was cut off resumes or is clearly marked as interrupted. Nothing is silently lost.

## R2. Projects and workspaces

- R2.1 A project is a Git checkout or a plain folder, registered by path.
- R2.2 A workspace is one piece of work: a chat with its worker, its changes, its terminals, and its artifacts.
- R2.3 A workspace starts from a first prompt or a kanban card. The first prompt or card title names it. It can be
  renamed, parked (agents stopped, files kept), and archived (transcripts and artifacts kept as history).
- R2.4 Git isolation options: a new worktree at `~/.pi-spore/worktrees/<project>/<slug>-<short id>` on branch
  `<prefix>/<slug>-<short id>`, an existing branch, or the main checkout.
- R2.5 Folder isolation options: a scratch copy or the folder itself.
- R2.6 New worktrees get the gitignored files they need from a declared copy list in
  `<project>/.pi-spore/config.toml`, copied with btrfs reflinks where the filesystem supports it. Copied files are
  never read into logs, transcripts, or artifacts.
- R2.7 `setup` runs after a worktree is created and `teardown` runs before it is removed.

## R3. Agents and roles

- R3.1 Roles: worker (the only agent that writes in a workspace), reviewer, adversarial reviewer, coordinator, and
  subagent. Roles are provided by modules.
- R3.2 Role defaults (model, thinking level, prompt) come from the user's pi-subagents setup: the agent files and
  `subagents.agentOverrides` in `~/.pi/agent/settings.json`. pi-spore adds overrides per project, run, and
  workspace.
- R3.3 A worker can start pi-subagents helpers. The UI shows them as child runs of that worker.
- R3.4 pi-spore never changes a role's model without approval. Choosing a router model (R4) counts as approval
  for every model that router picks.
- R3.5 Agents have a `request_human_input` tool. Agents in a run ask their coordinator instead (R7).
- R3.6 Concurrency and nesting limits for agents are settings, with safe defaults.

## R4. Model routing and local models

- R4.1 pi-spore ships a Pi extension that registers a router virtual model (working name `spore/auto`). It works in
  the plain `pi` CLI too.
- R4.2 The router sends a task to a local model (Strata today) only when the task is bounded: the kind of task the
  implementer subagent, Haiku, or Luna would get. All of these must hold:
  - the requirements are explicit and well defined;
  - the code change is straightforward;
  - the task is not visual (no scenes, prefabs, UI layout, shaders, art, or anything judged by looking at it);
  - the brief plus the files it names fit well inside the local model's context (Strata: 128k).
- R4.3 The TypeSafe Jev classifier answers R4.2's judgment questions. A deterministic token estimate checks the
  context fit. Anything uncertain goes to the cloud model.
- R4.4 Work done by a local model is always reviewed by a stronger model before it can pass the pipeline. This is
  enforced by the pipeline, not left to the prompt.
- R4.5 The local model runs one job at a time. A second job routed to it waits in line, and the UI shows
  "waiting for Strata".
- R4.6 The router supports more than one local target, each with its own context limit and concurrency, so the
  coming larger-context local server can be added by config.
- R4.7 Every routing decision is recorded with its reasons and shown in the UI. Decisions and outcomes (gates,
  review findings) are kept so the thresholds can be tuned.
- R4.8 Lane model approval: lanes start on role defaults without asking. pi-spore asks on Home only when the
  coordinator wants a model that is more expensive or slower than the role default.
- R4.9 The default implement stage uses the router, not the parent model. A worker that inherits the parent model
  (often Opus 5.5) spends Claude subscription usage on tasks a local implementer could do. Bounded work should go local by default.
- R4.10 Usage pressure: when the Claude weekly window is above 75% or the 5-hour window is at 100% (R18), the
  router leans local:
  - It accepts bounded tasks at a lower Jev confidence.
  - For roles pinned to a cloud model, pi-spore suggests a switch to the local implementer on Home. The user
    approves or declines (R3.4).
  - Visual tasks and tasks that do not fit the local context still never go local.
  - The thresholds are settings.

## R5. Chat UI

- R5.1 Rendered Markdown, code, tool calls, and images.
- R5.2 Steer while the agent works, queue follow-ups, and abort.
- R5.3 Change model or thinking level for the next message.
- R5.4 A context-usage meter with compact-now.
- R5.5 Slash commands for prompt templates.
- R5.6 Extension dialogs (select, confirm, input) from Pi extensions appear in the chat and on Home.

## R6. Review pipelines

- R6.1 A pipeline is a declared file of stages. Each stage has a role, a model or tier, a thinking level, a round
  limit, and gates. No fixed state machine.
- R6.2 Pipeline files live in `~/.pi-spore/pipelines/` and `<project>/.pi-spore/pipelines/`. A project file with
  the same id wins.
- R6.3 The default pipeline:
  1. `implement`: the worker.
  2. `review`: a fresh read-only reviewer each round, at most 2 rounds back to the worker.
  3. `adversarial`: an adversarial reviewer, one fix pass on REVISE.
  4. `gates`: the project's checks, plus a recorded fail-first proof for each new test.
- R6.4 Round limits are hard. A Jev check after each review round may stop early when the remaining findings are
  minor. It can never add rounds.
- R6.5 Fail-first proof: the worker records the failing run of each new test as an artifact. The reviewer checks it.
  The gate stage re-runs only the final passing suite.
- R6.6 Stages survive a server restart and resume from their last committed step.
- R6.7 Verdicts and findings (blocking, important, minor) are shown on the workspace.
- R6.8 A workspace can run a pipeline without a run.

## R7. Coordinator runs and lanes

- R7.1 A run is a coordinator conversation that owns lanes. Each lane is a workspace with its own worktree and
  worker.
- R7.2 Lanes form a wave graph: a small contract wave first when later lanes share types, then independent lanes in
  parallel.
- R7.3 The coordinator settles the spec with the user, proposes lanes, writes each lane brief to artifacts, starts
  lanes, answers lane questions, reads each lane's diff and report, runs the gates, and merges.
- R7.4 One integration branch per run (`run/<slug>-<short id>`). Lanes merge into it. One PR goes from it to the
  base branch. A human merges that PR.
- R7.5 Questions go up the chain. A lane asks its coordinator. The coordinator answers from the spec or escalates
  to the user's inbox. No lane-to-lane messages. Agents outside a run ask the user.
- R7.6 A question is a durable delivery: it wakes the coordinator (or reaches the inbox) without polling and
  survives restarts.

## R8. Changes and review

- R8.1 Per-workspace changes: uncommitted, staged, committed, or one commit.
- R8.2 A diff viewer.
- R8.3 Comments on diff lines that attach to the composer and go with the next message.

## R9. Pull requests (GitHub via `gh`)

- R9.1 The worker or the user publishes the branch and opens the PR.
- R9.2 pi-spore watches checks and conflicts with the base. It sends failures (with log tails) back to the worker,
  at most 3 tries in a row, then stops and waits for the user.
- R9.3 pi-spore never merges and never enables auto-merge.

## R10. Unity support

- R10.1 A project is detected as Unity when `ProjectSettings/ProjectVersion.txt` exists.
- R10.2 Unity projects copy `Library/`, `*.csproj`, and `*.sln` into new worktrees by default (R2.6), with a
  warning when Unity has the main checkout open (`Temp/UnityLockfile`).
- R10.3 "Open in Unity" on any workspace starts the right editor version for that worktree.
- R10.4 One Unity editor per project at a time. pi-spore holds an editor lease that names the owner: the user or an
  agent's workspace.
- R10.5 Opening Unity on another worktree of the same project needs the current editor closed first. pi-spore asks
  the user before it closes an editor the user owns. It never closes one without a yes, because closing discards
  unsaved changes.
- R10.6 Unity test gates run in batch mode with the editor closed for that worktree:
  - If the user has the editor open, the gate waits, or asks the user for permission to close it.
  - If another agent holds the lease, the gate waits until that agent releases it.
- R10.7 Agents reach the editor of their own worktree through unity-mcp. They never reach another project's editor.

## R11. Kanban

- R11.1 One board across all projects, filterable by project. Stored in the pi-spore database.
- R11.2 Columns: Backlog, Ready, In progress, Review, Done.
- R11.3 A card has a title, a body, a project (optional), labels, a due date (optional), and "blocked by" links to
  other cards or workspaces.
- R11.4 A card can start a workspace or a run. The card then moves by itself when the work changes state.
- R11.5 Agents add and update cards through a tool and the CLI, but only when asked.
- R11.6 Kanban replaces the separate todo list.

## R12. Actions

- R12.1 Named commands in `<project>/.pi-spore/config.toml`. `setup` and `teardown` are reserved.
- R12.2 `exclusive` actions run one at a time per directory.
- R12.3 Actions run from the UI or by agents. Logs are kept on disk.

## R13. Terminals

- R13.1 Terminals open in the workspace directory with its env.
- R13.2 Terminals survive a browser reload and reconnect.

## R14. Artifacts

- R14.1 A per-workspace folder outside every working copy, for plans, specs, briefs, diffs, reports, verdicts,
  routing records, and test proofs.
- R14.2 Markdown is rendered. HTML is previewed in a sandboxed frame.
- R14.3 Artifacts are kept after archive.

## R15. Attention

- R15.1 A Home page shows what needs the user across projects: waiting for input, questions, approvals, extension
  dialogs, failures, and running work.
- R15.2 Desktop notifications.
- R15.3 Park a workspace.

## R16. CLI and API

- R16.1 An HTTP API with TypeBox schemas. The CLI uses only this API.
- R16.2 Mutating requests are idempotent through client-supplied keys.
- R16.3 Mutating agent tools are replay-safe through operation receipts keyed by the job and tool call.

## R17. Settings

- R17.1 Global settings and per-project settings. Each value shows where it came from: default, global, project
  file, local override, or detected.
- R17.2 Resolve order, later wins: defaults → global → project file → local override → run/workspace override.
- R17.3 The project file may be committed and never holds model choices. Model choices live in Pi settings or in
  pi-spore's global or local settings.

## R18. Subscription usage

- R18.1 A Usage screen shows each subscription plan (Claude, OpenAI Codex): 5-hour and weekly utilization, reset
  times, and when the numbers were last seen.
- R18.2 It also shows token use per project, workspace, role, and model from Pi session files. Local models show
  as free.
- R18.3 Usage seen by any Pi process counts, including plain `pi` in a terminal, not only pi-spore agents.
- R18.4 Home warns when a window crosses a threshold. The router reads the same numbers (R4.10).
- R18.5 Stale numbers are shown as stale and are not used for routing.

## Out of scope for v1

- v2: full-text search over conversations, MCP manager UI (v1 shows the MCP servers read-only), services with
  ports, snooze and wait-on rules, BTW side chat.
- Not planned: Perforce or other VCS (the provider interface must not assume Git), voice input, mobile layout,
  changelog page, multi-user, hosting, external runtime plugins, other agent CLIs as workbench agents, schedules,
  auto-merge.
