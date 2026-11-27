# Spike Hermes 0.2: Hermes protocol behavior and the Hermes-to-Pi channel

> Amended 2026-11-26: see [hermes-pi-spore-profile.md](hermes-pi-spore-profile.md).

- Date: 2026-11-25
- Card: Hermes 0.2. The ADR card (Hermes 0.3) decides from these facts.
- Target: the Hermes API server on the tailnet node `hermes-docker`, port `8642`, profile `homelab-maintainer`.
  Every path below is under `http://hermes-docker:8642/p/homelab-maintainer`.
- Hermes version on the target: **0.23.3** (release date 2026.9.24), from `/health`.
- Status: **live probes done.** Security findings block phases. See [Gaps](#gaps-that-block-a-phase).

## How each answer is marked

- **probed on v0.23.3**: a live request from the desktop. Raw request and response below, key redacted.
- **source v0.23.3**: read in the Hermes source. The desktop has a clean checkout at `~/.hermes/hermes-agent`, at
  tag `v0.23.3`, the same version as the container. Stronger than docs, weaker than a probe: the container's config
  picks code paths.
- **docs only**: from the Hermes docs site. Not proof.

## Probe setup

- Key: `~/.pi-spore/hermes/homelab-maintainer.key` (mode `0600`, folder `0700`). It came from Hermes by a one-time
  RSA-OAEP transfer. The transfer files are deleted.
- Every request sends `Authorization: Bearer <redacted>`. The header is built with `printf` and passed as
  `curl -H @<(...)`, so the key is never in argv, a log, or this doc.
- Throwaway sessions: `pi-spore-spike-1795663303` (source `api_server`) and
  `pi-spore-spike-foreign-1795663329` (source `cli`, made to test the ownership rule). No gateway-owned chat got a
  message.
- Prompts: "reply with the word pong", `sleep 25`, `sleep 45`, one `curl` to a closed desktop port, and the one
  command the user approved in advance:
  `mkdir -p /tmp/pi-spore-spike-approval && rm -r /tmp/pi-spore-spike-approval`.
- No change to Hermes config, Docker, Tailscale, or pi-spore settings.

## Run mode on this install

Source v0.23.3 has two `/v1/runs` code paths. Probed on v0.23.3: `features.run_unknown_resolution` is `true`, so
this install runs the **session authority** path. Every run has a durable admission row (`admission_id`,
`execution_generation`). The connector must code for this path only, and refuse to start when the flag is `false`.

## Answers

### 1. Capabilities

Probed on v0.23.3.

```text
GET /v1/capabilities  -> 200
{"object": "hermes.api_server.capabilities", "platform": "hermes-agent", "model": "hermes-agent",
 "auth": {"type": "bearer", "required": true},
 "runtime": {"mode": "server_agent", "tool_execution": "server", "split_runtime": false, ...},
 "features": {
  "chat_completions": true, "chat_completions_streaming": true, "responses_api": true,
  "responses_streaming": true, "run_submission": true,
  "runs_idempotency": {"supported": true, "durable": true, "retention_seconds": 86400},
  "run_status": true, "run_events_sse": true, "run_stop": true, "run_steer": true,
  "run_approval_response": true, "tool_progress_events": true, "approval_events": true,
  "session_resources": true, "model_options": true, "session_chat": true, "session_chat_streaming": true,
  "session_fork": true, "session_model_lock": true, "reasoning_streaming": true,
  "admin_config_rw": false, "jobs_admin": false, "memory_write_api": false, "skills_api": true,
  "audio_api": false, "realtime_voice": false,
  "session_continuity_header": "X-Hermes-Session-Id", "session_key_header": "X-Hermes-Session-Key",
  "run_unknown_resolution": true, "cors": true},
 "endpoints": {"health", "health_detailed", "models", "model_options", "chat_completions", "responses",
  "runs", "run_status", "run_events", "run_approval", "run_steer", "run_unknown_resolution", "run_stop",
  "skills", "toolsets", "sessions", "session_create", "session", "session_update", "session_delete",
  "session_messages", "session_fork", "session_chat", "session_chat_stream", "session_model_lock"}}
(endpoints abridged to their names; each has a method and a path)

GET /v1/capabilities, no key  -> 401 {"error": {..., "code": "gateway_auth_failed"}}
GET /v1/models                -> 200, model ids: ["homelab-maintainer"]
```

No version field. No `clarify` flag. `cors: true` means CORS origins are set on this listener (pi-spore does not
need CORS; it calls from its server).

Required flags for the connector: `run_submission`, `run_status`, `run_events_sse`, `run_stop`,
`run_approval_response`, `approval_events`, `session_resources`, `run_unknown_resolution`, and
`runs_idempotency.supported` and `runs_idempotency.durable` both `true`.

### 2. Idempotency and lost POSTs

Probed on v0.23.3.

```text
POST /v1/runs  Idempotency-Key: pi-spore-spike-ik-<n>
{"input": "Reply with the word pong and nothing else.", "session_id": "pi-spore-spike-1795663303"}
-> 202 {"run_id": "run_c8690ae01f474f40a13eb8f242f2e7b6", "status": "started", "replayed": false}

same key, same body
-> 202  Idempotency-Replayed: true
   {"run_id": "run_c8690ae01f474f40a13eb8f242f2e7b6", "status": "completed", "replayed": true}

same key, other body ("Reply with the word ping.")
-> 409 {"error": {"message": "Idempotency-Key was already used with a different request payload",
        "code": "idempotency_key_conflict"}}

Idempotency-Key: "has space"
-> 400 {"error": {"message": "Idempotency-Key must be 1-255 visible ASCII characters",
        "code": "invalid_idempotency_key"}}
```

- There is no "list runs" endpoint and no lookup by `session_id` (source v0.23.3).
- Rule for "uncertain": always send an `Idempotency-Key` (pi-spore's delivery id). After a timeout, send the exact
  same body again with the same key. The answer names the original run, or starts it once. Never change the body
  on a retry; a changed body is a `409`.
- Retention: 24 h after the run ends (`retention_seconds: 86400`). A run that has not ended is not pruned (source).

### 3. Run lifetime

Probed on v0.23.3. The user restarted Hermes once at 19:28 (gateway pid 725, then 335; `draining`, port closed
about 15 s, then `starting`).

```text
before the restart: run_c1e83207... ("sleep 600") status running

after the restart:
GET /v1/runs/run_c8690ae0...  -> 200 "status": "completed", "output": "pong"      (finished before)
GET /v1/runs/run_313a6965...  -> 200 "status": "cancelled"                       (finished before)
GET /v1/runs/run_c1e83207...  -> 200 "status": "unknown", "execution_generation": 7, "usage": {}
GET /v1/runs/run_c1e83207.../events -> 404 run_not_found       (the SSE buffer is gone)
POST /v1/runs, first Idempotency-Key and body again -> 202 Idempotency-Replayed: true, "status": "completed"

POST /v1/runs {"input": "Reply with the word pong ...", "session_id": "pi-spore-spike-1795663303"}
-> 202 {"run_id": "run_8cbd4b1d...", "status": "started"}
   15 s later: "status": "queued"     (it waits behind the unknown run)

POST /v1/runs/run_c1e83207.../resolve-unknown {}  -> 400 invalid_params
POST /v1/runs/run_c1e83207.../resolve-unknown
     {"admission_id": "86e103ea...", "execution_generation": 7}
-> 200 {"run_id": "run_c1e83207...", "status": "terminal", "outcome": "interrupted", "authority_epoch": 9, ...}
GET /v1/runs/run_c1e83207...  -> "status": "cancelled"
run_8cbd4b1d... then ran: "status": "completed", "output": "pong"
```

- Run status survives a restart. It is stored in the durable admission row.
- A run cut off by a restart becomes `unknown`. Every later run in **that session** waits in `queued` until the
  client sends `POST /v1/runs/{id}/resolve-unknown` with exactly `{admission_id, execution_generation}` from the
  status. Then the cut-off run ends `cancelled`, and the queue moves on. The connector must do this, or the
  session stalls. Whether the cut-off tool call ran to the end is not known; treat it as "maybe ran".
- A queued run has `"execution_generation": null` (source v0.23.3: `session_admissions.generation` is NULL until
  the run is `started`).
- The `202` of `POST /v1/runs` says `"status": "started"` even when the run is queued. Read the real state from
  `GET /v1/runs/{id}`.
- The SSE stream of a run does not survive a restart (`404`). Poll the status instead.
- An unknown id answers `404 {"error": {"code": "run_not_found"}}`.
- How long a finished run stays: 24 h after it ends (`retention_seconds`); not waited out live.
- Statuses seen live: `queued`, `running`, `unknown`, `completed`, `cancelled`. In source also:
  `waiting_for_approval`, `failed`, `interrupted`.

### 4. SSE

Probed on v0.23.3.

```text
GET /v1/runs/run_c8690ae01f474f40a13eb8f242f2e7b6/events
19:22:20.088 : open
19:22:26.260 id: 0
19:22:26.262 data: {"event": "message.delta", "run_id": "run_c8690...", "timestamp": 1795663346.25,
                    "delta": "pong", "seq": 0}
19:22:26.726 id: 1
19:22:26.728 data: {"event": "run.completed", "run_id": "run_c8690...", "timestamp": 1795663346.72,
                    "output": "pong", "usage": {...}, "runtime": {...}, "completed": true,
                    "partial": false, "interrupted": false, "seq": 1}
19:22:26.729 : stream closed
```

- Frames carry `id:` and `data:` only. There is **no `event:` line**: the event name is in `data.event`. A browser
  `EventSource` sees every frame as `message`.
- Events seen live: `message.delta`, `tool.started` (`tool`, `preview`, `tool_call_id`), `tool.completed`
  (`duration`, `error`), `run.completed`, `run.cancelled`. No `run.started` or `run.queued` frame was sent in this
  mode. Source also has `message.started`, `message.interim`, `reasoning.available`, `tool.progress`,
  `tool.failed`, `approval.request`, `approval.responded`, `clarify.request`, `run.steered`, `run.stopping`,
  `run.failed`, `run.interrupted`, `replay.truncated`.
- Resume, probed: after the run ended, `GET .../events` again replays all frames from `id: 0`.
  With `Last-Event-ID: 0` it replays from `id: 1`. Source: when old frames are gone it first sends
  `replay.truncated` with `oldest_retained_seq`; the buffer is in memory and is swept 300 s after the run starts
  when no one listens.
- Keepalive, probed: `: keepalive` every 10 s while a tool runs (19:24:19 tool.started, 19:24:29 and 19:24:39
  keepalive).

### 5. Approvals

Probed on v0.23.3. **Security finding: no approval was asked.**

```text
POST /v1/runs  {"input": "Use your terminal tool to run exactly this one shell command, unchanged:
  mkdir -p /tmp/pi-spore-spike-approval && rm -r /tmp/pi-spore-spike-approval  Then reply with the word done. ..."}
-> 202 {"run_id": "run_072a7b4e6c90464c87eea055f1437deb", "status": "started"}
SSE: tool.started (preview "mkdir -p /tmp/pi-spore-spike-approval + 1 command"), tool.completed (error false),
     message.delta "done", run.completed
GET /v1/runs/run_072a...  -> "status": "completed", "pending_controls": []
```

- Hermes' own detector (source v0.23.3, `tools/approval_detection.detect_dangerous_command`, run on the desktop)
  flags this command: `(True, 'delete in root path')`. So the gate was skipped, not missed.
- Source v0.23.3 skips the gate when one of these is true: the terminal backend is `docker` with no host mounts,
  or `modal`, `daytona`, `vercel_sandbox`; `approvals.mode` is `off`; YOLO is on; the command matches a permanent
  allow rule; or `smart` mode clears it. The API cannot read the config (`admin_config_rw: false`), so this spike
  cannot tell which. The user must run on Unraid:
  `docker exec <container> hermes -p homelab-maintainer config get approvals` and
  `docker exec <container> hermes -p homelab-maintainer config get terminal`.
- No other flagged command was sent. The planned `deny` test did not run: with the gate skipped it would only
  have run.
- Body shape (source v0.23.3, session-authority path): `POST /v1/runs/{id}/approval` with exactly
  `{"request_id": "<pending_controls[].prompt_id>", "execution_generation": <int>, "choice": "<c>"}`. Any other key
  answers `400 invalid_params`. A stale generation answers `stale_generation`. Choices: `once`, `session`,
  `always`, `deny`. pi-spore must only send `once` or `deny`.
- `approvals.timeout`: source v0.23.3, default 300 s; at timeout the command is blocked ("timed out without user
  response").

### 6. Clarify

Probed on v0.23.3: **does not reach a `/v1/runs` client on this install.**

```text
GET /v1/toolsets  -> clarify: enabled false, tools ["clarify"]
POST /v1/runs {"input": "Use your clarify tool to ask me exactly one question: 'ping or pong?' ..."}
SSE: message.delta "ping or pong?", run.completed; pending_controls []
```

The agent asked in plain text and the run ended. Source v0.23.3: when the toolset is on, the session-authority
path sends `clarify.request` and takes `POST /v1/runs/{id}/clarify` with exactly
`{"request_id", "execution_generation", "answer"}`. The connector must treat a final message that asks a
question as an ordinary reply.

### 7. Stop

Probed on v0.23.3.

```text
POST /v1/runs {"input": "Use your terminal tool to run exactly: sleep 45  Then reply with the word done."}
SSE 19:24:03 tool.started (preview "sleep 45")
19:24:05 POST /v1/runs/run_313a.../stop
-> 200 {"run_id": "run_313a...", "status": "stopping", "admission_id": "d7624bc2..."}
SSE 19:24:05 tool.completed (error true)
SSE 19:24:05 run.cancelled {"completed": false, "partial": false, "interrupted": true,
                            "turn_exit_reason": "interrupted_by_user"}
POST .../stop again -> 200 {"status": "cancelled", ...}   (idempotent)
```

The running `sleep` was killed in under 1 s.

### 8. Sessions

Probed on v0.23.3.

```text
POST /api/sessions {"id": "pi-spore-spike-1795663303", "title": "pi-spore-spike-1795663303"}
-> 201 {"object": "hermes.session", "session": {"id": "pi-spore-spike-1795663303", "source": "api_server",
        "message_count": 0, ...}}
same POST again -> 409 {"error": {"code": "session_exists"}}
GET /api/sessions?source=api_server&limit=5 -> 200, data: [("pi-spore-spike-1795663303", "api_server")]
GET /api/sessions?limit=20 -> 200 {"object", "data", "limit", "offset", "has_more"}; sources seen: tool, webui
GET /api/sessions/pi-spore-spike-1795663303/messages?limit=3
-> 200 {"object": "list", "data": [{"id": 7954, "role": "user", ...}, {"id": 7955, "role": "assistant",
        "content": "pong"}, {"id": 7956, "role": "session_meta"}], "pagination": {...}}

POST /api/sessions {"id": "pi-spore-spike-foreign-1795663329", "source": "cli"}  -> 201, source "cli"
POST /v1/runs {"input": "Reply with the word pong.", "session_id": "pi-spore-spike-foreign-1795663329"}
-> 409 {"error": {"message": "permission_denied", "code": "permission_denied"}}
GET .../pi-spore-spike-foreign-1795663329/messages -> 0 messages (nothing got in)
```

- Ownership is marked by `source` only. No other field says "API-owned". Source v0.23.3: a run into a session
  whose `source` is not `api_server` or `bot_room` is refused with `permission_denied` before anything is stored.
  The test used a throwaway session with `source: "cli"`, so no real chat was touched.
- Message fields: `id` (an integer), `role`, `content`, `session_id`, `timestamp`, `tool_calls`, `tool_name`, and
  more. Query: `limit`, `offset`, `order` (`oldest` or `latest`). No "after id" filter.
- **Scope finding:** the key reads **every** session of this profile, not only API ones. A read of a `webui`
  session's messages answered `200` (only the status and count were looked at).
- Probed on v0.23.3, profile `pi-spore`, 2026-11-26: the list query pi-spore sends,
  `GET /api/sessions?source=api_server&limit=100&offset=0`, answered `200`. So did `offset=100` (`has_more` false)
  and every subset of `source`, `limit`, and `offset`. The log line `Could not read the Hermes session record
  { error: 'Error: near ",": syntax error' }` of that day was pi-spore's own SQL, not Hermes: a handoff read its
  new session's record before Hermes had a model in it, then ran an `UPDATE` with no columns. Fixed; the warning now
  names its `call` (`chat` or `handoff`), and its `error` names the Hermes status.

### 9. Version check

Probed on v0.23.3: `GET /health` needs no key and returns
`{"status": "ok", "platform": "hermes-agent", "version": "0.23.3"}`. So does `/p/homelab-maintainer/health`.
`capabilities` has no version. `/health/detailed` (with the key) also has `version`.

Rule: the connector reads `/p/<profile>/health` and refuses a minor version it was not tested on (today `0.23.x`),
with an error that names both versions. Then it reads `capabilities` and refuses when a required flag from Q1 is
missing or `false`. Flags decide features; the version guards against untested releases.

### 10. Pull channel

Probed and source v0.23.3. **No clean pull channel exists on the HTTP API.**

| Candidate | Result |
|---|---|
| Plugin `ctx.register_rpc` | Source: served over the gateway socket (`/api/ws`), not over HTTP. Ruled out by the no-WebSocket decision. Plugins cannot add HTTP routes to the API server (no such registrar in `hermes_cli/plugins_context.py`). |
| Bot relay outbox (`message_agent`) | Source: drained by the Desktop app over the gateway socket (`bot_relay.outbox.drain`). Ruled out. |
| `/api/jobs` | Probed: `200 {"jobs": []}`. The agent's `cronjob` toolset is on, so an agent could leave a job as a "message". But a job is a schedule that can fire an agent turn. Misuse, not a channel. |
| A dedicated API session | Probed: pi-spore can create and read it. But only API calls write into it. A Hermes agent in another chat has no tool that writes into it. |
| Poll other sessions | Probed: the key reads every session. pi-spore could poll a chat for a marker. That means reading the user's private chats. Too wide. |

A pull channel needs a Hermes-side writer that the HTTP API can read. v0.23.3 has none.

### 11. Listener fallback

Probed (network) and source v0.23.3.

- Network, probed: the Hermes container reaches the desktop's Tailscale address. A `curl` from the container to
  `100.118.5.45:7999` (closed port) failed with `(7) Failed to connect ... after 0 ms`, which is an active refusal,
  not a timeout. So packets from `hermes-docker` reach the desktop today.
- MCP client entry (source v0.23.3, `tools/mcp_tool_config.py`): `mcp_servers.<name>.url` and `headers` resolve
  `${VAR}` and `${env:VAR}`, so the bearer token stays in the profile `.env`. Config only, no Hermes code. The
  agent calls pi-spore's tools like any tool. Dedupe: MCP's JSON-RPC `id` is per connection, not stable across a
  retry. The tool schema must carry its own `request_id` argument, and the agent fills it.
- A2A client (`a2a_call`): source has the tools; probed: the `a2a` toolset is **off** for the API server. It needs
  Hermes config plus an A2A server on the desktop. Larger.
- Plugin tool (`ctx.register_tool`): Python code in the Hermes home. It can send a stable id (for example the
  `tool_call_id`). Largest, and Hermes-side code pi-spore must ship and update.

Smallest: the **MCP client entry**.

### 12. A2A plugin

Probed on v0.23.3: the `a2a` toolset exists and is disabled for `api_server` (`a2a_call`, `a2a_discover`,
`a2a_history`, `a2a_list`, `a2a_orchestrate`). Task states: not probed (optional, off).

## Pick for the Hermes-to-Pi channel

**Listener fallback with an MCP client entry.** pi-spore runs a small MCP endpoint on the desktop, bound to the
Tailscale address only, with its own bearer token. Hermes gets one `mcp_servers` entry with the URL and
`headers: {Authorization: "Bearer ${env:PI_SPORE_MCP_TOKEN}"}`. Each tool takes a `request_id` that pi-spore
dedupes on.

Why not pull: v0.23.3 has no Hermes-side writer that the HTTP API can read without the WebSocket or reading private
chats.

## Capability matrix

| Needed feature | Endpoint | Present (probed v0.23.3) |
|---|---|---|
| Version | `GET /health` | yes |
| Feature flags | `GET /v1/capabilities` | yes |
| Start a run | `POST /v1/runs` | yes |
| Safe retry | `Idempotency-Key` on `POST /v1/runs` | yes, durable, 24 h |
| Poll a run | `GET /v1/runs/{id}` | yes |
| Stream a run | `GET /v1/runs/{id}/events` | yes |
| Resume a stream | `Last-Event-ID` | yes |
| SSE keepalive | comment frame | yes, 10 s |
| Approval request reaches the client | `approval.request` | **no: gate skipped on this install** |
| Approve or deny | `POST /v1/runs/{id}/approval` | not reachable (no request to answer) |
| Clarify | `POST /v1/runs/{id}/clarify` | **no: clarify toolset off** |
| Stop | `POST /v1/runs/{id}/stop` | yes |
| Sessions create, list, read | `/api/sessions...` | yes |
| Refuse writes to chats the API does not own | `409 permission_denied` | yes |
| List runs | none | no |
| Pull outbox | none | no |
| Container reaches desktop | tailnet | yes |
| Run status survives a restart | `GET /v1/runs/{id}` | yes; a cut-off run is `unknown` |
| Clear a cut-off run | `POST /v1/runs/{id}/resolve-unknown` | yes |

## Gaps that block a phase

1. **Dangerous commands run without approval (blocks any phase that runs tools).** A flagged `rm -r` ran with no
   `approval.request`. Unblock: the user reads `approvals` and `terminal` config on Unraid (commands in Q5),
   changes them so the gate applies, and a new probe shows `approval.request`, then `deny` blocks the command.
2. **The key reads every session of the profile (blocks the session-reading phase until accepted).** Unblock: the
   ADR either accepts this scope, or picks a profile that holds only pi-spore's sessions.
3. **The dashboard on `9119` answers over the tailnet** (found without the key: login page, public
   `/api/status`). The runbook says it stays on loopback. Unblock: bind it to `127.0.0.1` or block `tcp:9119` to
   `hermes-docker` in the Tailscale policy, then `curl http://hermes-docker:9119/` from the desktop fails.
4. **Clarify is off (blocks a clarify feature only).** Unblock: turn on the `clarify` toolset for `api_server`
   and probe `clarify.request`. Not needed for the first phase.
5. **Listener needs setup (blocks the Hermes-to-Pi phase).** Unblock: card Hermes 1.4 adds the MCP endpoint and
   the Hermes `mcp_servers` entry; a probe shows one tool call with a `request_id` arriving once.

## Sources

- Hermes source: `~/.hermes/hermes-agent` at tag `v0.23.3`: `gateway/platforms/api_server.py`,
  `api_server_runs.py`, `api_server_run_idempotency.py`, `api_server_authority_runs.py`,
  `gateway/session_api_turn.py`, `tools/approval.py`, `tools/approval_detection.py`,
  `tools/approval_context.py`, `hermes_cli/plugin_rpc.py`, `hermes_cli/plugins_context.py`, `tools/bot_relay.py`,
  `tools/mcp_tool_config.py`.
- API server docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Plugins docs: https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
- Setup runbook: [hermes-setup.md](hermes-setup.md)
