# 0197. Archive a workspace when its PR merges

- Status: Accepted
- Date: 2026-11-23
- Requirements: R9, R2

## Context

- A workspace whose PR merged stays active until the user archives it by hand. The user asked on 2026-11-23 that
  pi-spore archive it by itself, and that this be on by default.
- Archive stops the chats, terminals, and action runs of the workspace, runs teardown and the Unity editor guard,
  and removes the copy. Without `force`, uncommitted work or a failed step refuses it.
- AGENTS.md: pi-spore never closes a Unity editor without an explicit yes. It must not throw away work either.

## Decision

- A global setting `workspaces.archiveOnMerge` (boolean, default `true`) sets the default.
- Each workspace may override it with a field, not a settings layer: `archiveOnMerge` on the workspace
  (`workspaces_workspaces.archive_on_merge`, NULL follows the setting). `PATCH /api/workspaces/:id` sets it, and
  `null` clears it. ADR 0170 ("workspace settings stay read-only") still holds.
- When github-pr sees a PR become merged (the Merge button, "merge when checks pass", a watch poll, the discover
  job, a refresh), it starts a durable `github-pr.auto-archive` job keyed by the workspace (ADR 0004). Its one step:
  - does nothing when the workspace is not active or parked, the setting or override is off, or the stored PR is
    no longer merged;
  - does not archive while work runs: a chat that is busy, starting, or waiting, a chat with helpers running, or a
    workspace working label such as a pipeline run;
  - calls `WorkspacesKey.archive(id, { force: false })`. It never forces. Uncommitted work, an open Unity editor,
    and a failed teardown stop it;
  - does not retry.
- An archive that did not happen goes to Home: `PR #<n> merged; archive <workspace> by hand`, with the reason. It
  goes away when the workspace is archived.
- An archive asks the provider `lostWork` before it leaves active, so a refused archive stops no chat, terminal,
  or run. This holds for the user's archive too.
- Archive keeps the branch, the artifacts, and the chats until retention (ADR 0121).

## Consequences

- Most merged workspaces leave the active list on their own. Work is never lost: the branch stays, and a dirty
  copy is left for the user.
- A workspace with no card and no watch learns of a merge only on a refresh, because the discover job skips it.
- Run PRs (`open_run_pr`) go through the same PR row, so a merged run PR archives its workspace too.
- The Settings page shows the setting with Edit and Reset (ADR 0170). The per-workspace switch in the UI is a later
  change.
