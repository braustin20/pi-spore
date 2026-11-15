# Spike: scout and researcher helpers for read-only chats

- Date: 2026-11-14
- Pi: 1.5.0, pi-subagents 0.86.0, Node 26, Linux
- Question: how can the planner chat (ADR 0174) and the run coordinator (ADR 0150) start `scout` and `researcher`
  helpers without the raw `subagent` tool, which can start a writing `worker`?
- Method: read the installed docs (`~/.pi/agent/npm/node_modules/pi-subagents/docs/`: `extension-api.md`,
  `configuration.md`, `tool-reference.md`, `agents.md`, `workflows.md`). Then drove real
  `pi --mode rpc --no-session --model claude-bridge/claude-haiku-5-5 --tools <list> --exclude-tools 'mcp__*'`
  sessions in `/tmp/spike-helpers/ws` with a throwaway extension (`-e /tmp/spike-helpers/ext.ts`) and a driver that
  logged every RPC record. The user's normal Pi extensions loaded, so pi-subagents and its agent overrides applied
  (scout on Haiku, researcher on Sonnet). The scripts are not in the repo.

## Answers

### 1. Can a parent limit which agents `subagent` may start?

Yes: a **capability ceiling** (`extension-api.md`, "Capability ceilings"). An extension in the parent process calls
`registerSubagentCapabilityCeiling({ sessionId, source, ceiling: { allowedAgents, allowedTools, denyExtensions } })`
from the public export `pi-subagents/capability-ceiling`. The registry lives on `globalThis` under
`Symbol.for("pi-subagents.capability-ceiling.v1")`, so a second copy of the module, imported by path, meets the copy
pi-subagents uses. It must be keyed by `ctx.sessionManager.getSessionId()`. The ceiling passes down to nested and
background children. There is no config key or env var for an agent allowlist.

What I ran (`--tools read,subagent`, ceiling `allowedAgents: ["scout", "researcher"]`):

| Call | Result |
|---|---|
| `{ agent: "worker", task, async: true }` | Refused before spawn: `Capability ceiling from spike does not allow agent 'worker'. Allowed agents: researcher, scout.` |
| `{ workflow: "parallel", args: { tasks: [scout, worker] } }` | The workflow started. The `worker` child failed with the same message. The `scout` child ran. |
| `{ chain: [...] }` | Refused: `Legacy top-level chain and parallel inputs were removed; use a workflow script`. Chains are workflow scripts now, and their children pass the same admission check as `parallel`. |
| `{ action: "list" }` | Listed scout and researcher as executable, and every other agent under "Restricted agents (capability ceiling: spike)". |

So the ceiling holds for single runs and workflow children (parallel, chain, dynamic fanout all start children
through `runs.run`/`runs.all`).

**The ceiling also matters for the helpers' own tools.** The built-in `scout` has
`tools: read, grep, find, ls, bash, write, contact_supervisor`. The user's `researcher` (`~/.agents/researcher.md`)
has only read and web tools, but the built-in one has `write`. A run with only `allowedAgents` let scout run
`touch e.txt` and write `f.txt` in the chat's folder: both files appeared. The same run with
`allowedTools: read,grep,find,ls,web_search,fetch_content,get_search_content,source_check` gave scout only
`read, grep, find, ls`. It reported that it had no bash or write tool, and no file appeared. The researcher kept its
web tools under that ceiling and answered a `web_search` question. Its report still reached the parent; the runtime
saved it under `/tmp/pi-subagents-uid-1000/artifacts/outputs/<run>/`, not in the chat's folder.

### 2. Can a parent force `async: true`?

Only partly through config. `forceTopLevelAsync: true` (`configuration.md`) forces depth-0 single, parallel, and
chain runs into the background, but it is a global pi-subagents config key in the user's file, not a per-session
setting. A `tool_call` handler can change the input: setting `event.input.async = true` on a `subagent` call with
`async: false` started the scout in the background (`Async: scout [...] Detached.`).

### 3. Can a spore-bridge tool start a run through the extension API?

Yes: the in-process event-bus RPC (`extension-api.md`, "In-process event-bus RPC"). The extension listens for
`subagents:rpc:v1:ready`, emits `subagents:rpc:v1:request` with
`{ version: 1, requestId, method: "spawn", params: { agent, task, context: "fresh", cwd } }`, and reads
`subagents:rpc:v1:reply:<requestId>`. `spawn` is async-only by design: it accepts no foreground run. It uses the same
executor as the `subagent` tool, so ceilings, depth, and spawn caps apply.

What I ran: a throwaway `start_helper { agent: "scout" | "researcher", task }` tool, with
`--tools read,start_helper`, so the model never had `subagent`.

- The ready event arrived at session start. The spawn reply came back in about 30 ms:
  `success: true`, `details.runId`. Its text tells the model to check with `subagent({ action: "status" })`,
  a tool the chat does not have, so a real tool must write its own result text.
- About 6 s later the parent got a `subagent-notify` custom message ("Background task completed: **scout**") that
  started a new turn on its own. The model quoted the scout's answer. No polling.
- `agent: "worker"` never reached the tool: Pi's argument check answered
  `Validation failed for tool "start_helper": agent: expected one of ["scout","researcher"]`.
- With `PI_SUBAGENT_MAX_DEPTH=0` the spawn failed: `Nested subagent call blocked (depth=0, max=0)`.

### 4. Do these helpers show as child runs and count in `agents.maxLive`?

Yes, with no pi-spore change. During the RPC-spawned run the process sent `setWidget` `subagent-async` records with
`kind: "pi-subagents.async-status-snapshot"`, `version: 1`, and the run with `state: "running"` and its step
(`agent: "scout"`, `model: "claude-bridge/claude-haiku-5-5"`, `thinking: "low"`). That is the record ADR 0034 reads
for every agent process (`modules/agents/src/manager.ts`, `parseChildRuns`), whatever its kind. So the run shows in
the chat's helper list, counts against `agents.maxLive` while it runs, keeps the chat from stopping for idleness,
and sets `helpersRunning`. The widget was cleared after the run ended, as in spike Q5.

## Other facts

- pi-subagents only loads in a pi-spore agent when the user's Pi setup loads it (ADR 0025). Without it, the ready
  event never arrives.
- The raw `subagent` tool has many actions besides starting a run: agent `create`, `update`, and `delete` (they write
  agent files), `output` paths, `worktree: true`, missions, schedules, lane records, project panes, and doctor
  (`tool-reference.md`, "Management actions"). A ceiling limits agents and child tools, not these. I did not try them.
- Workflow children are offered to permission extensions as a nested `subagent_launch` tool call, but not in a
  session whose `--tools` list leaves that tool out, and not for RPC spawns (`workflows.md`).

## Limits of this method

- One model (Haiku) drove the parent. Each case ran once.
- Not tried: `resume`, `steer`, or `stop` of a helper; a ceiling with a `researcher` that has a nested `subagent`
  tool; a pi-subagents version other than 0.86.0.
