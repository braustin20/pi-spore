# 0167. The nesting limit is the pi-subagents depth, set by pi-spore

- Status: Accepted
- Date: 2026-11-09
- Requirements: R3.3, R3.6

## Context

R3.6 asks for a nesting limit for agents, as a setting with a safe default. ADR 0026 covers only concurrency
(`agents.maxLive`, `agents.idleStopMinutes`).

Only pi-subagents helpers nest: a worker starts a helper (ADR 0034), and that helper can start its own. pi-spore's
own starts do not nest without bound. A workspace has one pipeline run at a time, and lanes start through the
server.

pi-subagents already has a depth limit. Its default is 2. A parent reads it from the env var
`PI_SUBAGENT_MAX_DEPTH`, then from its config `maxSubagentDepth`. It hands the limit to each child. A call past it
fails with "Nested subagent call blocked (depth=N, max=M)".

## Decision

- "Nesting" is the depth of pi-subagents helpers below an agent that pi-spore starts.
- The global setting `agents.maxSubagentDepth` holds it: a whole number, 0 or more, default 2. `0` means no
  helpers.
- pi-spore sets `PI_SUBAGENT_MAX_DEPTH` to this value in the env of every agent process it starts. The setting wins
  over the same variable in the server's env. pi-subagents refuses the deeper helper itself. pi-spore adds no check
  of its own.

## Consequences

- Inside pi-spore the setting overrides the user's pi-subagents `maxSubagentDepth`. The `pi` CLI keeps that config.
- The Settings page shows the real limit with its source.
- The error a refused helper gets comes from pi-subagents. It names the depth and the limit, not the pi-spore key.
- Tests check the env of each agent launch. They cannot run pi-subagents, so the refusal itself is not tested here.
- The setting is read when the server starts, like the other `agents.*` keys.
