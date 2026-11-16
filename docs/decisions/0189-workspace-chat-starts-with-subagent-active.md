# 0189. A workspace chat starts with `subagent` active

- Status: Accepted
- Date: 2026-11-16
- Requirements: R3.1, R3.4
- Builds on: [ADR 0120](0120-orchestrator-chat-and-card-models.md), [ADR 0162](0162-orchestrator-starts-pipeline-runs.md)

## Context

- An orchestrator chat asked the user on Home whether to run a `reviewer` on its plan. The user said yes. The chat
  could not start the reviewer, and asked the user to type a message in the chat first.
- The gate is in the user's pi-subagents package. A new session may start with only the loader tool
  `subagents_enable`; `subagent` stays registered but inactive until the model calls the loader.
- On a provider that fixes the tool list for a whole prompt, such as the `claude-bridge` models the orchestrator
  runs on, `subagent` turns on only at the next user prompt. A Home answer does not count as one. The pi-subagents
  docs (`docs/configuration.md`, "Tool activation lifecycle") say to start Pi with
  `--exclude-tools subagents_enable` to keep `subagent` active from the start.

## Decision

1. A workspace chat launches with `--exclude-tools subagents_enable` (`WORKSPACE_CHAT_TOOLS` in
   `modules/agents/src/launch.ts`). `subagent` is active from its first request, so it can start `scout`,
   `researcher`, or `reviewer` in the same turn that a Home answer arrives in.
2. Pi treats `--exclude-tools` as a filter on registered tools. When pi-subagents is not installed, the flag does
   nothing, so it is passed always.
3. Side chats, planner chats, and stage reviewers keep their allowlists, which name neither tool. Stage workers keep
   `--exclude-tools contact_supervisor` only: they do not start subagents. A run coordinator keeps its launch hook's
   allowlist, which uses `start_helper` and not `subagent`.
4. The rules do not change. The orchestrator still runs a `reviewer` only after the user says yes. This removes an
   extra message; it grants no new authority.

## Consequences

- The `subagent` schema goes with every request of a workspace chat: a few more input tokens per request.
- A chat whose session already recorded the loader changes its tool list once, on its next request.
