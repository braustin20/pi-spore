# 0030. One writing agent per workspace, fresh chats, and read-only side chats

- Status: Accepted
- Date: 2026-11-07
- Requirements: R3.1, R3.8, R3.9

## Context

Each workspace has exactly one worker agent and one conversation (`UNIQUE (workspace_id, role)` in the agents
table). The user wants more than one chat per workspace. Two agents writing in the same worktree would overwrite
each other's changes; the user's own rules already say one writer per worktree. BTW side chats were moved to v2
in ADR 0019.

## Decision

- Still one writing agent per workspace at a time: the worker.
- **New chat**: the user can start a fresh worker conversation in a workspace. The previous worker chats stay as
  read-only history the user can open and switch back to; switching back makes that chat the active worker chat.
  Only the active worker chat can run.
- **Side chats** (BTW) move into v1: any number of read-only chats next to the worker, started empty or from a
  copy of the worker's current context (a Pi fork of its session). Side chats get read-only tools (no `edit`,
  `write`, or write-capable `bash` use) and do not count against the live-agent limit any differently from other
  agents (ADR 0026 still applies).
- The chat page lists the workspace's chats: the active worker chat first, then side chats, then older worker
  chats.

## Consequences

- The agents table moves from one row per workspace and role to many, with an `active` worker per workspace.
- Read-only must be enforced by the tools a side chat gets, not by its prompt.
- ADR 0019's v2 list loses "BTW side chat".
