# 0040. Cards move on workspace state changes; any archive means Done

- Status: Accepted
- Date: 2026-11-07
- Requirements: R11.4

## Context

ADR 0012 says a card moves to Done when its workspace is "archived as done". Archiving has no done or dropped
flag, and adding one would change the archive request and its dialog. Cards must also keep a manual move until the
work changes state again.

## Decision

- The kanban module moves a card only when its workspace changes state: started from the card → In progress,
  archived → Done. Any archive counts as done. If the work was dropped, the user moves the card back.
- The workspaces contract gets `afterStateChange(workspace, previous)`, called after park, resume, and archive, and
  `create(request)`, so kanban starts a workspace in the same request that links the card.
- Later modules move cards through `CardsKey.workChanged(workspaceId, column, reason)`.

## Consequences

- No change to the archive request or dialog.
- A dropped workspace puts its card in Done until the user moves it.
- Since moves happen only on state changes, a manual move is never undone by a refresh or a restart.
