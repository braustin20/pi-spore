# Spike Hermes 0.2: Hermes protocol behavior and the Hermes-to-Pi channel

- Date: 2026-11-25
- Card: Hermes 0.2. The ADR card (Hermes 0.3) decides from these facts.
- Target: Hermes API server on the tailnet node `hermes-docker`, port `8642`, profile `homelab-maintainer`
  (`/p/homelab-maintainer/...`).
- Hermes version on the target: **0.23.3** (release date 2026.9.24), probed from the public `/health`.
- Status: **draft. Live checks partly blocked.** The desktop has no key file
  `~/.pi-spore/hermes/homelab-maintainer.key`, so no probe that needs the bearer key has run yet. See
  [Live checks blocked](#live-checks-blocked).

## How each answer is marked

- **probed on v0.23.3**: a live request from the desktop to `hermes-docker:8642`. Raw request and response below.
- **source v0.23.3**: read in the Hermes source. The desktop has a clean checkout at `~/.hermes/hermes-agent`, at
  tag `v0.23.3`, with no local changes. That is the same version as the container. Source is stronger than docs,
  but it is not a live probe: the container's config can switch code paths (see
  [Two run modes](#two-run-modes)).
- **docs only**: from the Hermes docs site. Not proof.

## Live checks blocked

These need the key. They stay open until the user puts the key file on the desktop (runbook
[hermes-setup.md](hermes-setup.md), step 2.1, mode `0600`):

- Q1 the real `GET /v1/capabilities` body on this install.
- Q2 `POST /v1/runs` with `Idempotency-Key`, replay, and a lookup after a timeout.
- Q3 `GET /v1/runs/{id}` after a container restart (needs the user to restart, or a natural restart).
- Q4 the SSE event names, `Last-Event-ID` resume, and the keepalive interval, seen on the wire.
- Q5 approval request, body, choices, and timeout with the profile's `approvals.mode`.
- Q6 clarify over `/v1/runs`.
- Q7 stop end state.
- Q8 session create, list, read, and the `409 permission_denied` on a gateway-owned session.
- Q10 the pull candidates (`/api/sessions/{id}/messages`, `/api/jobs`).

## Probes that ran (no key)

All on 2026-11-25 from the desktop.

```text
$ curl -sS -D- http://hermes-docker:8642/v1/capabilities
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Server: Python/3.14 aiohttp/3.14.5
{"error": {"message": "Invalid gateway API key (API_SERVER_KEY)", "type": "gateway_auth_error",
 "code": "gateway_auth_failed"}}

$ curl -sS http://hermes-docker:8642/health            -> 200
{"status": "ok", "platform": "hermes-agent", "version": "0.23.3"}
$ curl -sS http://hermes-docker:8642/v1/health         -> 200 (same body)
$ curl -sS http://hermes-docker:8642/p/homelab-maintainer/health -> 200 (same body)
$ curl -sS http://hermes-docker:8642/p/nonexistent-profile/health
{"error": "Unknown or unconfigured profile", "code": "profile_unknown"}

$ curl http://hermes-docker:8642/p/homelab-maintainer/v1/capabilities  -> 401
$ curl http://hermes-docker:8642/v1/models                             -> 401
$ curl http://hermes-docker:8642/api/sessions                          -> 401
$ curl http://hermes-docker:8642/api/ws                                -> 404
$ curl http://hermes-docker:9119/       -> 302 Location: /login?next=%2F (server: uvicorn)
$ curl http://hermes-docker:9119/api/status -> 200
{"version":"0.23.3","release_date":"2026.9.24", ..., "gateway_running":true,
 "gateway_platforms":{"api_server":{"state":"connected"},"discord":{...},"hermex":{...}}, ...}
$ curl http://hermes-docker:9120/       -> connect failed
$ curl http://tower:8642/               -> connect failed
```

What this shows:

- Hermes runs as its own tailnet node `hermes-docker` (the runbook's "Tailscale for the container" option). Unraid
  (`tower`) publishes no 8642.
- `homelab-maintainer` is a configured profile with its own key: its prefix answers, an unknown prefix answers
  `profile_unknown`.
- `/api/ws` is not on 8642.
- **Security finding:** the dashboard on `9119` answers from the desktop over the tailnet. It shows a login page,
  and `/api/status` is public. The 0.1 runbook says 9119 stays on loopback. This spike changes nothing. The user
  must decide: bind the dashboard to `127.0.0.1`, or block `tcp:9119` to `hermes-docker` in the Tailscale policy.

## Two run modes

Source v0.23.3: `/v1/runs` has two code paths. Which one runs depends on whether the gateway has a "session
authority" (`gateway_runner.session_authority`). `GET /v1/capabilities` tells which: `features.run_unknown_resolution`
is `true` only with the session authority. Several answers below differ by mode. The live `capabilities` call
decides.

| Point | Session authority (`run_unknown_resolution: true`) | Legacy (no authority) |
|---|---|---|
| Run state store | durable admission row per run | memory, plus the idempotency DB for keyed runs only |
| Approval body | exactly `{request_id, execution_generation, choice}` | `{choice, request_id?, all?}` |
| Clarify | `POST /v1/runs/{id}/clarify` with `{request_id, execution_generation, answer}` | not served (the route only calls the authority path) |
| Stop | queued: cancelled; running: stop of that claim | `{"run_id","status":"stopping"}`, then `run.cancelled` |
| Lost owner | status `unknown`; later turns wait for `POST /v1/runs/{id}/resolve-unknown` | status `interrupted` |

## Answers

### 1. Capabilities

Source v0.23.3 (`gateway/platforms/api_server.py`, `_handle_capabilities`). Not yet probed.

Body shape: `object: "hermes.api_server.capabilities"`, `platform`, `model`, `auth: {type: "bearer", required}`,
`runtime`, `features`, `endpoints`. Flags in v0.23.3:

- always `true`: `chat_completions`, `chat_completions_streaming`, `responses_api`, `responses_streaming`,
  `run_submission`, `run_status`, `run_events_sse`, `run_stop`, `run_steer`, `run_approval_response`,
  `tool_progress_events`, `approval_events`, `session_resources`, `model_options`, `session_chat`,
  `session_chat_streaming`, `session_fork`, `session_model_lock`, `reasoning_streaming`, `skills_api`.
- always `false`: `admin_config_rw`, `jobs_admin`, `memory_write_api`, `audio_api`, `realtime_voice`.
- object: `runs_idempotency: {supported: true, durable: <bool>, retention_seconds: 86400}`.
- depends on the gateway: `run_unknown_resolution`, `cors`.
- strings: `session_continuity_header: "X-Hermes-Session-Id"`, `session_key_header: "X-Hermes-Session-Key"`.

There is no `clarify` flag and no version field.

Proposed required set for the connector: `run_submission`, `run_status`, `run_events_sse`, `run_stop`,
`run_approval_response`, `approval_events`, `session_resources`, and `runs_idempotency.supported == true` with
`durable == true`. Decide `run_unknown_resolution` after the live probe.

### 2. Idempotency and lost POSTs

Source v0.23.3 (`api_server_runs.py`, `api_server_run_idempotency.py`). Not yet probed.

- `POST /v1/runs` reads the header `Idempotency-Key` (1 to 255 visible ASCII characters, else `400
  invalid_idempotency_key`).
- The same key and the same body (fingerprint: SHA-256 of the body plus `X-Hermes-Session-Key`) answers `202`
  with the **original** `run_id`, `"replayed": true`, and header `Idempotency-Replayed: true`. The replay skips the
  concurrency limit.
- The same key with another body answers `409 idempotency_key_conflict`.
- Reservations live in SQLite `runs_idempotency.db` in the Hermes home ("durable"). Terminal rows are pruned after
  24 hours. A run that is not terminal is never pruned.
- There is no "list runs" endpoint and no lookup by `session_id`.

So "uncertain" works like this: always send an `Idempotency-Key` (pi-spore's own delivery id). After a timeout,
send the exact same POST again. It answers with the original run, or starts it once. Never change the body on a
retry.

### 3. Run lifetime

Source v0.23.3. Not yet probed.

- Legacy mode: run status lives in memory. A terminal status is kept 3600 s (`_RUN_STATUS_TTL`). A run's SSE
  buffer is swept 300 s after creation when no one listens (`_RUN_STREAM_TTL`), but a live run keeps its status.
- After a gateway restart, `GET /v1/runs/{id}` answers only for runs started **with** an `Idempotency-Key`. Those
  load from `runs_idempotency.db`. If the run was not terminal and its owner process is gone, the status becomes
  `interrupted` with `error: "The gateway restarted before this run settled."`. Runs without a key answer `404
  run_not_found`.
- Session-authority mode: status comes from the durable admission row (`queued`, `running`, `unknown`,
  `waiting_for_approval`, then `completed`, `failed`, or `cancelled`).

Terminal statuses: `completed`, `failed`, `cancelled`, `interrupted`.

### 4. SSE

Source v0.23.3 (`_handle_run_events`). Not yet probed on the wire.

- Event names in the source: `run.queued`, `run.started`, `message.started`, `message.delta`, `message.interim`,
  `reasoning.available`, `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`, `approval.request`,
  `approval.responded`, `run.steered`, `run.stopping`, `run.completed`, `run.failed`, `run.cancelled`,
  `run.interrupted`, `replay.truncated`. Session-authority mode also projects `clarify.request`.
- Each frame is JSON with `event`, `run_id`, `timestamp`, `seq`, and the SSE `id:` is `seq`.
- Resume: send `Last-Event-ID: <seq>` (or `?last_seq=<seq>`). The server replays from its buffer. If older events
  are gone it first sends `replay.truncated` with `oldest_retained_seq`.
- The stream opens with the comment `: open`, sends `: keepalive` every 10 s when idle, and ends with
  `: stream closed`.
- A slow reader is dropped (5 s write timeout, or queue overflow).
- The buffer lives in memory. It does not survive a restart.

### 5. Approvals

Docs and source v0.23.3. Not yet probed.

- Docs: with `approvals.unattended_mode: deny`, `api_server` sessions block dangerous commands at once. But on
  `/v1/runs` the client can answer, so Hermes still sends `approval.request`.
- Legacy body: `POST /v1/runs/{id}/approval` with `{"choice": "<c>", "request_id": "<id>"}`. Choices: `once`,
  `session`, `always`, `deny` (aliases such as `approve` are normalized). `"all": true` resolves every pending
  request. Answer: `{"object": "hermes.run.approval_response", "run_id", "choice", "request_id", "resolved"}`.
  Errors: `400 invalid_approval_choice`, `409 approval_not_active`, `409 approval_not_pending`.
- Session-authority body: exactly `{"request_id", "execution_generation", "choice"}`. Any other key is refused
  (`invalid_params`). `execution_generation` comes from `GET /v1/runs/{id}`.
- pi-spore must only ever send `once` or `deny`. `session` and `always` widen the grant.
- `approvals.timeout` behavior: not found yet. Live probe needed.

### 6. Clarify

Source v0.23.3. Not yet probed. Served only in session-authority mode (see [Two run modes](#two-run-modes)).
Body `{"request_id", "execution_generation", "answer"}`. No capability flag announces it.

### 7. Stop

Source v0.23.3. Not yet probed. Legacy: answers `{"run_id", "status": "stopping"}`, then the run ends `cancelled`
with `run.cancelled`. A run already terminal answers its status. A run not in this process answers `409
run_not_active`.

### 8. Sessions

Source v0.23.3. Not yet probed. Routes: `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`,
`GET /api/sessions/{id}/messages`, `POST .../fork`, `.../chat`, `.../chat/stream`, `.../model`. Session rows carry
`source`; the API stamps `source: "api_server"`. The `409 permission_denied` on a gateway-owned session: still to
probe.

### 9. Version check

Probed on v0.23.3: `GET /health` (and `/p/<profile>/health`) is public and returns `version`. `capabilities` has
no version.

Proposed rule: the connector reads `/health` first and refuses a major or minor version it was not tested on
(today `0.23.x`), with an error that names both versions. Then it reads `capabilities` and refuses when a required
flag is missing. Flags decide features; the version only guards against untested releases.

### 10. Pull channel

Source v0.23.3, first findings. Not yet probed.

- Plugin `ctx.register_rpc`: the methods are served over the gateway socket (`/api/ws`), not over the HTTP API
  server. That path is ruled out by the user's decision. **Not usable.**
- `/api/jobs`: cron jobs. Readable with the key. `jobs_admin` is `false` in capabilities. Still to probe what a
  job shows (last output, last run time).
- A dedicated API session read with `GET /api/sessions/{id}/messages`: readable. Open question: how a Hermes agent
  in another chat writes into it.

### 11. Listener fallback

Source v0.23.3, first findings. Not yet probed.

- MCP client: `mcp_servers.<name>.url` and `headers` support `${VAR}` and `${env:VAR}` interpolation
  (`tools/mcp_tool_config.py`).
- A2A: Hermes has an `a2a` platform plugin (`plugins/platforms/a2a/`). Still to read.

### 12. A2A plugin

Source v0.23.3: the plugin exists in the source tree. Whether it is enabled on the container: not yet probed.

## Capability matrix

Draft. "source" means present in v0.23.3 code; the live column fills in after the key probes.

| Needed feature | Endpoint | Source | Live |
|---|---|---|---|
| Version | `GET /health` | yes | **yes** |
| Feature flags | `GET /v1/capabilities` | yes | blocked |
| Start a run | `POST /v1/runs` | yes | blocked |
| Safe retry | `Idempotency-Key` on `POST /v1/runs` | yes | blocked |
| Poll a run | `GET /v1/runs/{id}` | yes | blocked |
| Stream a run | `GET /v1/runs/{id}/events` | yes | blocked |
| Resume a stream | `Last-Event-ID` | yes | blocked |
| Approve or deny | `POST /v1/runs/{id}/approval` | yes | blocked |
| Clarify | `POST /v1/runs/{id}/clarify` | authority mode only | blocked |
| Stop | `POST /v1/runs/{id}/stop` | yes | blocked |
| Sessions | `/api/sessions...` | yes | blocked |
| List runs | none | **no** | n/a |

## Sources

- Hermes source: `~/.hermes/hermes-agent` at tag `v0.23.3`: `gateway/platforms/api_server.py`,
  `api_server_runs.py`, `api_server_run_idempotency.py`, `api_server_authority_runs.py`,
  `gateway/session_api_turn.py`, `hermes_cli/plugin_rpc.py`, `tools/mcp_tool_config.py`.
- API server docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Plugins docs: https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
- Setup runbook: [hermes-setup.md](hermes-setup.md)
