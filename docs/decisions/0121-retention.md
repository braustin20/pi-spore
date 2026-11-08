# 0121. Delete the data of finished work after a retention time

- Status: Proposed
- Date: 2026-11-07
- Requirements: R17.1, R17.2
- Changes: ADR 0110 (closed chats are no longer kept forever)

## Context

- Archive removes a workspace's folder (`removeCopy`) and keeps its row. Closing a chat keeps its row and session
  file (ADR 0110). Nothing removes chat history, routing decisions, or action logs, so they pile up.
- Disk use is small (sessions 3.4 MB, database 3.1 MB on 2026-11-07). This is about hygiene and privacy, not space.
- A module owns its tables and never queries another module's tables (ADR 0003). One module cannot delete
  everything a workspace left behind.

## Decision

### The setting

- `retention.days` in `~/.pi-spore/settings.json`. Default 30. `0` turns cleanup off.
- It must be a whole number, 0 or more. Any other value is refused with an error that names `retention.days`. A
  bad value deletes nothing.
- The projects module reads it, as it reads project settings, and shows it on the Projects page with its source
  (`default` or `global`, R17.1). It is a global setting only: a project file cannot set it.

### What is deleted

When an item is older than `retention.days`:

- An **archived workspace**, counted from the day it was archived (`archived_at`): its session folder
  (`~/.pi-spore/sessions/<workspace>/`), its chats and their deliveries, its questions and approvals, its review
  comments, its PR records, its action runs and their logs (`~/.pi-spore/logs/actions/<workspace>/`), its Unity
  lease, and last its workspace row. It leaves the workspace list.
- A **closed chat**, counted from the day it was closed (`closed_at`): its session file, its deliveries, its
  questions and approvals, and its row. The running server forgets it too, so its id answers 404 at once. A closed
  chat stays while an open fork of it has not started yet, because that fork's first start reads its session.
- **Routing decisions**: lines of `~/.pi-spore/usage/routing.jsonl` whose `at` is older. Lines without a readable
  `at` stay.
- **Action runs** that ended before the limit, in any workspace: the run row and its log file.
- **Stored responses** in `core_idempotency` older than the limit, including bridge receipts. A retry or a tool
  call replay comes within minutes, not after the limit.

### What is never deleted

- Active or parked workspaces, and the open chats in them.
- Git branches, kanban cards, artifacts, and the folder of an in-place workspace (archive never removed it).
- A card whose workspace is deleted keeps the card. Its workspace link is cleared and the card is marked archived
  (`archived_at`). The board hides archived cards behind a "Show archived" toggle. Moving an archived card out of
  Done clears the mark.
- Data outside pi-spore's own tables and folders, such as pi-subagents' temp run state and copies of history in
  forks that are still open.
- Anything outside `~/.pi-spore`. Each delete checks that its path is inside the folder it belongs to and refuses
  it otherwise.

### Days of existing rows

- `archived_at` is a new column on `workspaces_workspaces`. Rows already archived get their `updated_at`. Archive
  set it; a later rename can have moved it later, which only keeps data longer.
- `closed_at` is a new column on `agents_agents`. Rows already closed get the server's time when the module
  starts after the migration (`host.now()`): the table has no `updated_at`, and a later day only keeps data
  longer.

### How modules take part

- The workspaces module runs the cleanup: once after every module's setup, before the server listens, and then
  once a day. `ServerHost.onStarted(listener)` is the seam; `setupModules` awaits its listeners after the last
  setup. Tests drive it with the injected clock and a restart, with no sleeps.
- It offers two hooks on `WorkspacesKey`:
  - `onRetention(listener(cutoff))`: a module deletes its own old data that is not tied to an archived workspace
    (agents: closed chats; usage: routing lines; actions: old runs).
  - `beforeDeleteWorkspace(listener(workspace))`: a module deletes what it holds for that workspace (agents,
    attention, changes, github-pr, kanban, actions, unity).
- The agents module offers `beforeDeleteChat(listener(agentId))` so attention can delete the questions and
  approvals of a closed chat.
- The server core offers `ServerHost.pruneResponses(before)` for its stored responses. The workspaces module calls
  it in each run.
- No new chat starts in an archived workspace (409 `workspace_archived`), so a run cannot race a new chat.
- Listeners must be safe to run again. A listener that throws is logged and the others still run. A workspace whose
  listeners did not all succeed keeps its row and is tried again on the next run.
- The workspaces module removes the workspace row last and sends a `removed` event on `workspaces:list`.
- Each kind of data deleted gets one log line with a count. Logs never hold file contents.

## Consequences

- Old chat history is gone for good after the limit. There is no undo. `retention.days = 0` keeps everything.
- A routing line appended while the file is being trimmed can be lost. The router writes rarely and the log is
  informational, so this is accepted.
- New modules that store data per workspace or per chat register with these hooks.
- A module that is turned off during a run keeps its rows for deleted workspaces. Modules cannot be turned off
  yet; when they can, each module must clean up for workspaces that no longer exist when it starts again.
- Readers of session files and action logs treat a file that vanished as gone (404 or skipped), not as a server
  error.
