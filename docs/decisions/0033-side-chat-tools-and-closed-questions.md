# 0033. Side chat tools, and questions of older worker chats

- Status: Accepted
- Date: 2026-11-07
- Requirements: R3.5, R3.8, R3.9

## Context

ADR 0030 adds read-only side chats and fresh worker chats per workspace. Two points were left open.

Side chats must be read-only through their tools, not their prompt. A side chat loads the user's whole Pi setup
(R1.4): extensions that add tools (subagents, MCP adapters), Pi's built-in MCP support, and spore-bridge. A side
chat started from the worker's context is a Pi fork of the worker's session, and that session records the worker's
tool loadout (`edit`, `write`, `bash`). Pi 1.5 behaves like this (read in `agent-session.js`):

- `--tools <list>` is an allowlist. A built-in or extension tool it does not name is never registered. A restored
  loadout or an extension's `setActiveTools()` cannot turn it on, because Pi ignores names that are not registered.
- Pi's built-in MCP tools (`mcp__*`) stay registered past an allowlist that names none of them. `--exclude-tools`
  removes tools after all other selection, MCP tools included.

A worker chat can ask a question on Home and then stop being the active chat, because the user started a new chat
or switched to another. The question then belongs to a chat that cannot run.

## Decision

- Side chats start with `--tools read,grep,find,ls,request_human_input --exclude-tools 'mcp__*'`, on the first
  start and on every resume. They get no `edit`, `write`, `bash`, `codemode`, `tool_search`, subagent tools, or MCP
  tools. Of spore-bridge's tools they keep only `request_human_input`, which files a question and changes nothing.
  `check` and `run_action` run project commands, so they are left out.
- A side chat's bridge token is marked read-only, and `POST /api/bridge/runs` refuses it with 403 `read_only_chat`.
- spore-bridge gives side chats their own rules (`PI_SPORE_CHAT_KIND=side`): they can read and search, not change
  files, and should describe needed changes for the worker chat.
- When a worker chat stops being the active one, its open questions are closed (state `closed`). Home drops them.
  An answer to a closed question is refused with 409 `question_closed`. The question stays in the chat's history.
  After the user makes the chat active again, they write to it directly.
- A delivery that was already pending when the chat became inactive stays pending and goes out when the chat is
  made active again.

## Consequences

- No tool the model can call in a side chat writes files or starts agents, whatever the user's extensions add.
- Slash commands typed by the user still run in a side chat, because the user typed them. An extension command that
  starts a writing agent is the user's choice, not the model's.
- A new tool name in spore-bridge or Pi is off in side chats until it is added to the list in
  `modules/agents/src/launch.ts`.
- Home never shows a question that nobody can act on.
