# 0110. Closing a chat

- Status: Accepted
- Date: 2026-11-07
- Requirements: R3.1, R3.8

## Context

ADR 0030 lets a workspace hold many chats: the active worker chat, side chats, and older worker chats. Nothing
removed a chat from the chat bar, so the bar only grew.

## Decision

- The user can close any chat that is not working. A chat that is busy, starting, or waiting for a slot answers 409
  `chat_busy`: the user aborts or stops it first.
- Closing sets `closed = 1` and `active = 0` on the chat's row (`POST /api/agents/:id/close`) and stops its process.
  The row and the Pi session file stay. Other modules hold agent ids (attention items, links from cards), so a hard
  delete would leave them pointing at nothing.
- A closed chat is left out of the chat list, the `agents:list` snapshot, and Home. A `removed` event on
  `agents:list` drops it from open pages. It cannot be made active again.
- Closing the active worker chat leaves the workspace without one. The page's next "get the worker" call starts a
  fresh chat, as for a new workspace.
- The web asks for confirmation first, because the page has no way to bring a closed chat back.

## Consequences

- Session files of closed chats stay on disk. Deleting them is a separate, explicit act.
- A way to reopen a closed chat can come later without a data change: clear `closed`.
