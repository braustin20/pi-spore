# 0202. The Hermes profile `pi-spore` is a remote teammate, reached through one connector and an MCP listener

- Status: Accepted
- Date: 2026-11-26
- Requirements: R1.2, R1.4, R1.6, R7.5, R15.1, R16.2, R16.3, R17, R19
- Changes: [ADR 0143](0143-phone-over-tailscale-serve.md) in part ("pi-spore never listens on a Tailscale address")
- Builds on: [ADR 0002](0002-agent-runtime-pi-rpc.md), [ADR 0026](0026-agent-process-limits.md),
  [ADR 0032](0032-agent-tokens-and-bridge-routes.md), [ADR 0033](0033-side-chat-tools-and-closed-questions.md),
  [ADR 0155](0155-modules-add-home-items.md), [ADR 0179](0179-stage-agents-ask-the-asking-chat.md)

## Context

- The user runs Hermes (Nous Research's agent server) in Docker on their Unraid home server, on the tailnet node
  `hermes-docker`. One Hermes gateway serves all profiles on port `8642`, each under `/p/<profile>/`, each with its
  own key ([hermes-setup.md](../spikes/hermes-setup.md)).
- The user wants Pi agents and a Hermes agent to hand work to each other, and later a chat page with Hermes in
  pi-spore.
- Spike Hermes 0.2 ([hermes-protocol.md](../spikes/hermes-protocol.md)) probed the HTTP API on v0.23.3 against the
  profile `homelab-maintainer`:
  - `/v1/runs` runs on the session-authority path (`run_unknown_resolution: true`). Run admission is durable and
    idempotent through `Idempotency-Key` for 24 h. A changed body under a used key is `409`.
  - SSE frames carry `id:` and `data:` only. The event name is in `data.event`. `Last-Event-ID` replays. The stream
    does not survive a Hermes restart; the run status does.
  - A run cut off by a restart is `unknown`, and every later run of that session waits until a client sends
    `resolve-unknown`. Whether the cut-off tool call finished is not known.
  - Approval and clarify answers have exact bodies. Approval choices include `session` and `always`.
  - The key reads every session of its profile. Writes into a session whose source is not an API source are `409`.
  - The HTTP API has no pull channel. The smallest Hermes-to-Pi path is an MCP endpoint on the desktop that the
    Hermes container calls. The container already reaches the desktop's tailnet address.
- The amendment of 2026-11-26 ([hermes-pi-spore-profile.md](../spikes/hermes-pi-spore-profile.md)) adds
  operator-reported facts:
  - A new dedicated profile `pi-spore`, with nothing cloned: no chats, memories, skills, bot channels,
    infrastructure credentials, or MCP entries. Its key works only on `/p/pi-spore`.
  - `approvals.mode: manual`, `unattended_mode: deny`, `command_allowlist: []`. API toolsets `terminal` and
    `clarify` only. The terminal uses the `local` backend in the container. It is **not a sandbox**.
  - A `deny` blocked a flagged command. The spike's `rm -r` without a prompt ran under `smart` mode on
    `homelab-maintainer`, so it does not by itself prove a bypass.
  - Hermes routes the profile's model: primary `nous` / `openai/gpt-6.1-sol`, fallback `openai-codex` /
    `gpt-6.1-sol`. The run API's runtime fields can be blank while the session record names the provider.
- pi-spore today: every agent is a local `pi --mode rpc` process (ADR 0002) with a live slot (ADR 0026). The server
  binds `127.0.0.1` and checks peer, Host, and Origin (`guardRequest`, ADR 0143). Agents get their own tokens, and
  bridge routes take receipts (ADR 0032). Modules add Home items through sources (ADR 0155).
- The user chose: no SSH from the desktop to Unraid, and no use of the Hermes gateway WebSocket (card Hermes 2.2,
  dropped).

## Decision

1. **A remote teammate, not a workbench agent.** The Hermes profile `pi-spore` is a remote peer (R19). Pi workers
   stay local `pi --mode rpc` processes (ADR 0002). Hermes never runs in a worktree, never takes a pipeline, run,
   lane, or stage role, and never uses a live agent slot (ADR 0026).
2. **Not Homelab Maintainer.** The `pi-spore` profile has no inherited memories, chats, or skills. pi-spore has no
   handoff to Homelab Maintainer and assumes none. One needs its own supported and approved mechanism later, with
   its own ADR.
3. **Three concerns, in this order:**
   1. explicit task handoffs, both ways (cards Hermes 1.1 to 1.5);
   2. a native Hermes chat page on the same connector (cards Hermes 2.1, 2.3);
   3. the provider setup handoff, a separate later capability with its own ADR (cards Hermes 3.x).
4. **One connector, in process.** Module `modules/hermes` (`@pi-spore/mod-hermes`) in the pi-spore server. It talks
   outbound HTTP and SSE to `<hermes.url>/p/<hermes.profile>`, by default `http://hermes-docker:8642/p/pi-spore`.
   No sidecar process. Other modules reach it only through its interface key `HermesKey`.
5. **Protocol rules** (session-authority path, spike facts):
   - Startup check, in order: read `/p/<profile>/health` and refuse a minor version that was not tested (today
     `0.23.x`), naming both versions. Then read `/v1/capabilities` and refuse when a required flag from spike Q1 is
     missing or `false`, naming the flag. Then check that `/v1/models` lists the profile's model id.
   - SSE: the event name is `data.event`. Resume with `Last-Event-ID`. After a stream loss, or a `404` on events,
     poll `GET /v1/runs/{id}`.
   - Every `POST /v1/runs` sends an `Idempotency-Key`. A retry sends the identical body with the same key.
   - Approval answer: exactly `{request_id, execution_generation, choice}`, `choice` `once` or `deny` only. pi-spore
     never sends `session` or `always`.
   - Clarify answer: exactly `{request_id, execution_generation, answer}`.
   - A final message that asks a question in plain text is an ordinary reply.
6. **Outcomes are not exactly-once.**
   - Idempotent run admission is not exactly-once execution. Cancel (`stop`) does not undo side effects that already
     happened. Every message about a cancelled, failed, or uncertain handoff says so.
   - After a restart, a run in `unknown` is **reconciled** first: pi-spore reads the session's messages and tool
     events and shows the user what is known. Only then may the user pick "Mark as interrupted"
     (`resolve-unknown` with the exact `{admission_id, execution_generation}`), "Send again" (a new run with a new
     key, behind a confirm that says the first may have run), or "Drop".
   - pi-spore never sends `resolve-unknown` or a fresh run on its own.
   - One API session per handoff, named `pi-spore-<handoff id>`, so a stalled session blocks only that handoff.
7. **Model routing belongs to Hermes.** pi-spore sends no provider or model override, and never edits Hermes's
   provider config. It may show the provider and model from the session record. It treats blank run runtime fields
   as unknown, not as a failure. Codex `gpt-6.1-sol` is the configured fallback, not the primary.
8. **Secrets.**
   - The Hermes key is the file `~/.pi-spore/hermes/pi-spore.key`, folder `0700`, file `0600`. Setting
     `hermes.keyFile` holds the path, never the key. The connector reads the file when it calls, and refuses a
     missing or empty file or a wider mode, naming the path only.
   - The key never goes into argv, a log, a prompt, an agent's environment, the browser bundle, a committed file,
     or `settings.json`.
   - The MCP listener token is its own file, `~/.pi-spore/hermes/mcp.token`, with the same modes. It lives on Unraid
     only in the `pi-spore` profile's `.env`, read through `${env:VAR}`.
   - pi-spore's user token (`~/.pi-spore/token`) and agent tokens never leave the desktop.
9. **Trust.**
   - A peer message is task input, never the user's authorization. A Pi chat that works on a Hermes request keeps
     its normal role, rules, and approvals.
   - Every Hermes approval and clarify goes to the user on Home. pi-spore never answers one by itself, and no Pi
     agent can answer one.
   - No remote shell endpoint, no shared agent homes, no shared session databases.
   - Hop rule: a chat that works on a Hermes request cannot call `ask_hermes`, and a Hermes request that came from a
     Pi ask is refused. No loops.
   - Pi to Hermes (`ask_hermes`) is open to workspace chats and the planner chat. It is refused in stage chats, lane
     chats, read-only side chats (ADR 0033), and helpers. So it is no side channel between lanes (R7.5).
10. **Hermes to Pi: a dedicated desktop MCP listener** (the spike's pick).
    - It runs in the `hermes` module as its own HTTP server, on its own port (`hermes.mcp.port`), separate from the
      main server.
    - It binds the desktop's Tailscale address only. The address comes from the local network interfaces. pi-spore
      never runs `tailscale` (ADR 0143 holds). With no Tailscale address, the listener does not start and says why.
      It never binds `0.0.0.0`, `::`, or a LAN address.
    - Auth: only the MCP token. The user token and agent tokens get 401. It refuses a foreign Host and any request
      with an `Origin` header, and caps body size and request rate.
    - Narrow task tools only, no shell or file tools: `list_targets`, `submit_request`, `get_request`,
      `cancel_request`. Each mutating tool takes an app-level `request_id` for dedupe, because MCP's JSON-RPC `id` is
      not stable across a retry.
    - Durable: requests, acknowledgements, and results are rows in `hermes_handoffs`. Hermes reads results with
      `get_request` whenever it asks. Nothing pushes into a Hermes session. A restart or an offline side loses
      nothing.
    - The main server keeps its loopback, Host, and Origin guards unchanged.
    - The network rule for the listener (a Tailscale grant from Unraid to the desktop port) and the matching
      `mcp_servers` entry on the `pi-spore` profile are applied by the operator. Each needs the user's explicit yes
      (card Hermes 1.4).
    - "No pull channel" holds for this HTTP-only design. Hermes has a gateway WebSocket, which has `register_rpc`
      and a relay outbox. The user chose not to use it (no SSH, card Hermes 2.2).
11. **Session scope.** The `pi-spore` key reads every session of the `pi-spore` profile. That is accepted, because
    the profile holds only pi-spore and setup-test sessions. pi-spore writes only into API sessions it made
    (`source: api_server`). Hermes refuses a run into a session of another source with 409 `permission_denied`.
12. **The user's yes, and off by default.**
    - Each incoming Hermes request needs the user's Accept on Home before a Pi chat gets it. Decline stores
      `cancelled` with the reason. Only targets in `hermes.inbound.projects` are allowed; empty, the default, means
      none.
    - `hermes.enabled` is off by default. Off means no connection to Hermes, no listener, no tool, and no rail entry.
      The listener also needs `hermes.mcp.enabled`.

## Consequences

- R1.2, R1.4, and the "Not planned" line of the vision change: the main server is still loopback only, workbench
  agents are still Pi only, and a remote peer is a new, separate thing (R19).
- ADR 0143's "never listens on a Tailscale address" now has one exception: the Hermes MCP listener, on its own port,
  with its own token, off by default. The main server and `tailscale serve` stay as ADR 0143 says.
- The module opens its own listener with `node:http`. The module contract gets no listener hook. If SSE streams or
  the listener must close on shutdown, card Hermes 1.1 adds the smallest stop hook to `ServerHost`, with a test.
- A handoff can end `uncertain`. The user then reads what is known and picks. This costs a click, but nothing runs
  twice by itself.
- Hermes is **not a sandbox**. A task handed to it can change files in the Hermes container, beyond
  `/opt/data/pi-spore-bridge`. The `ask_hermes` tool text and the docs say so. Whether to narrow that reach is open
  question Q19.
- Approvals on `pi-spore` are known to ask and to block on `deny`. A positive `once`, the timeout, and the UI round
  trips are not yet proven. No phase that runs tools is done until card Hermes 1.5 proves them.
- Hermes upgrades can stop the connector (untested minor). That is on purpose. A new minor needs a test run and a
  change to the tested range.
- A later handoff to Homelab Maintainer, a chat with Hermes's own gateway sessions, or the provider handoff each need
  a new ADR.
