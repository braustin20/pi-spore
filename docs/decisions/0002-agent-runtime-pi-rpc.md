# 0002. Agents run as `pi --mode rpc` processes, not Pi Durable

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.4, R1.6

## Context

The source plan named Pi Durable (`@earendil-works/pi-durable` 1.5.0). Durable has its own extension format
(`defineExtension`). It does not load `pi-coding-agent` extensions. The user's setup depends on those:
claude-bridge (the default provider), `strata-model.ts` (starts and stops Strata), pi-subagents, pi-mcp-adapter,
and pi-lens. The user chose the Pi coding-agent stack over Durable.

That stack has two ways in:

- In-process SDK (`createAgentSession`). All agents share one Node process. Extensions with process-level state
  break: `strata-model.ts` keys its lease on `process.pid`, so the first agent to shut down would stop Strata
  under the others. Extensions also change `process.env`. One bad extension can crash the server.
- RPC mode (`pi --mode rpc`, driven by `RpcClient`). One process per agent, the same as running `pi` in a
  terminal. Extension dialogs come over the wire as `extension_ui_request`.

## Decision

Each agent is a `pi --mode rpc` child process driven by `RpcClient`. Workbench tools come from a pi-spore
extension (`spore-bridge`) loaded with `-e`. Workbench state lives in SQLite (ADR 0004), not Durable documents.

## Consequences

- Every Pi extension, skill, MCP server, and model works as in the CLI, with no port.
- Per-agent env is easy (unity-mcp project path, workbench token).
- Each agent costs about 0.5 GB idle and 0.9 GB busy, mostly language servers that pi-lens starts and the `claude`
  process claude-bridge runs per request (measured in [spike Q1](../spikes/q1-rpc-agents.md)). Live agents are
  limited (ADR 0026), and agents run without pi-lens (ADR 0025).
- Spike Q1 confirmed that RPC mode loads every package, extension, skill, prompt template, provider, and MCP tool of
  the user's setup, and that extension dialogs round-trip over `extension_ui_request`.
- Crash recovery is ours to build: jobs with checkpoints, durable deliveries, and receipts. A model turn cut off
  by a crash is not replayed; the session file keeps everything up to the last completed message.
- Pi upgrades are one `pi` update, shared with the CLI.
