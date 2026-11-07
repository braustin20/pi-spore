# Spike Q5: observing pi-subagents child runs

- Date: 2026-11-07
- Pi: 1.5.0, pi-subagents 0.86.0, Node 26.7.0, Linux
- Question: how does pi-spore see the helpers a worker starts through pi-subagents: run files under
  `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- Method: read the installed package (`docs/observability.md`, `docs/extension-api.md`, `src/`), then drove one real
  `pi --mode rpc --no-session --model claude-bridge/claude-haiku-5-5` agent. It started a background `scout` and
  was asked for the run's status. I logged every RPC record. A second run sent `/subagents-inspect-rpc` after the
  scout finished. The driver scripts were throwaway and are not in the repo.

## Answer

Neither of the two choices. pi-subagents reports its background runs to an RPC host as a widget, and pi-spore
already receives widgets over the same pipe.

| Source | Reaches pi-spore? | Verdict |
|---|---|---|
| `pi.events` (`subagent:async-started`, `subagent:child-status`, `subagent:jobs-changed`) | No. The docs say `pi.events` is in-process only and does not reach other processes. | Unusable. |
| Run files | Yes, but not under `~/.pi/agent/pi-subagents/` (that folder only holds `last-seen-version.json`). They live in `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/status.json`, with `<scope>` such as `uid-1000`. | Works, but needs the tmp scope rule, a match from run to parent session, and a watcher. |
| RPC widget `subagent-async` | Yes. In RPC mode pi-subagents calls `ctx.ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:{...}"])`. It reaches pi-spore as an `extension_ui_request` with `method: "setWidget"`. | **Chosen.** Documented for RPC hosts ("Host inspection protocol"). |
| RPC widget `subagent-inspect` | Yes, on request. `/subagents-inspect-rpc <requestId> <runId> [childId] --lines N` replies with one `PI_SUBAGENT_INSPECT_JSON:` widget, then clears it. | **Chosen** for transcripts. |

## What the widget carries

The first spike run produced this sequence, about once per second while the run was active:

1. `subagent-async` with the run `queued`, then `running` with one `step:0` child.
2. Updates with `state: "running"`, `activity.lastActivityAt`, and the child's `agent` (`scout`),
   `model` (`claude-bridge/claude-haiku-5-5`), and `thinking` (`low`).
3. `state: "complete"` with `endedAt`. About 10 s later the widget is cleared (`setWidget` without lines).

Payload: `{ kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt, caps, omitted, runs: [...] }`.
Each run has `id`, `kind` (`subagent`, `workflow`), `label`, `state` (`queued`, `running`, `complete`, `failed`,
`partial`, `paused`, `stopped`, `rejected`), times, `activity`, and `children` (steps, with `agent`, `model`,
`thinking`). The payload is bounded: 20 runs, 8 children per node, depth 3, 32 KiB. It holds the runs of the
agent's own Pi session only, so no matching of run to parent is needed. It has no file paths.

## Inspect reply

`/subagents-inspect-rpc req1 <runId> step:0 --lines 20` answered with `{ kind: "pi-subagents.inspect-reply",
version: 1, requestId, asyncId, childId, status, label, finalOutput, resolvedModel }`. `task` and `messages` appear
when the child's session file can be read. Errors come back in the same shape as `error: { code, message }`
(`not_found`, `foreign_session`, `stale`). Extension commands run at once during a streaming turn
(Pi `rpc-commands.md`, `prompt`), so the worker can be busy.

## Foreground helpers

A foreground helper is a Pi session inside the worker's own process. It is not in the widget. Its progress arrives
as `tool_execution_update` events of the worker's `subagent` tool call, which the chat already shows as a running
tool.

## Memory

A background helper runs in a detached runner process that pi-subagents starts. It costs memory like an agent
process. A foreground helper adds no process.

## Limits of this method

- The widget is cleared about 10 s after the last run ends, and everything is lost when the agent process exits.
  pi-spore cannot list helpers of a stopped agent. The runner processes may still be alive.
- Widget updates repeat with new timestamps. pi-spore must publish only when a field it shows changes.
- Not measured: the memory of a runner process, and behavior with workflow runs of many children.
