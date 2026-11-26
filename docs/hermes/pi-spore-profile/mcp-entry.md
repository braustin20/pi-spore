# The `mcp_servers.pi_spore` entry for the `pi-spore` profile

Part of [runbook.md](runbook.md), step S4. Card Hermes 1.4, [ADR 0202](../../decisions/0202-hermes-remote-teammate.md)
§10.

This is the Hermes side of the MCP listener that card Hermes 1.3 merged (`modules/hermes/src/mcp/listener.ts`).
Nothing here is applied: the entry changes the Hermes profile, so **the user applies step S4 with an explicit yes**.
See [runbook.md](runbook.md).

Every value in angle brackets is a placeholder. The real IP and the real token never go in this repo.

## The entry

`/opt/data/profiles/pi-spore/config.yaml` in the Hermes container
(`<hermes-data>/profiles/pi-spore/config.yaml` on Unraid):

```yaml
mcp_servers:
  pi_spore:
    url: "http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp"
    headers:
      Authorization: "Bearer ${env:PI_SPORE_MCP_TOKEN}"
    tools:
      include: [list_targets, submit_request, get_request, cancel_request]
      resources: false
      prompts: false
```

- The key is `pi_spore`, so the tools register as `mcp__pi_spore__list_targets` and friends, and the toolset is
  `mcp-pi_spore` (the bare server name works as an alias).
- `tools.include` holds the **server-native** names, not the `mcp__…__…` form
  ([Hermes: MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)). Those
  four are the whole listener; it registers nothing else. `include` wins if both filters are set, so leave `exclude`
  out.
- `resources: false` and `prompts: false` are belt-and-braces. The listener announces only the `tools` capability, so
  Hermes registers no utility tools either way.
- `${env:PI_SPORE_MCP_TOKEN}` is the SecretRef form of `${PI_SPORE_MCP_TOKEN}`; both resolve from the profile's secret
  scope, so the value lives only in `/opt/data/profiles/pi-spore/.env` (ADR 0202 §8, delivered in
  [token-delivery.md](token-delivery.md)). Never write the token in the entry. If the variable is unset or empty,
  Hermes fails the connect closed and names the variable, rather than sending the placeholder: that error is the
  check that the `.env` line is in the right profile.
- No `transport` key: Hermes uses MCP Streamable HTTP by default, which is what the listener speaks. `transport: sse`
  is the opt-in for legacy SSE servers, and this listener answers `405` to `GET` on purpose (it opens no server
  stream).

## Why the Tailscale IPv4, not the tailnet name

The listener binds the desktop's Tailscale IPv4 address (an address in `100.64.0.0/10` on the `tailscale0` or `utun*`
interface) and accepts **only** that exact `<ip>:<port>` as the HTTP `Host` header. Anything else gets
`403 {"error":{"code":"bad_host"}}`. A MagicDNS name or a tailnet host name is a different `Host`, so it is refused —
this is the DNS-rebinding guard, not a mistake to work around. So:

- Write `url: http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp`. Do **not** write
  `http://<desktop-tailnet-name>…`, even though that reads nicer and resolves fine inside the tailnet.
- Do not add a `Host` header of your own: the listener refuses a request whose `Host` is not its own address, and it
  refuses any request that carries an `Origin` header at all (`403 bad_origin`), so it stays unreachable from a
  browser.

Read the address on the desktop, and the port from pi-spore:

```bash
tailscale ip -4                        # the desktop's Tailscale IPv4 address
```

pi-spore's Settings page, or its listener state at `GET /api/hermes/mcp` (user token, on the desktop only), answers
`{"state":"listening","url":"http://<ip>:<port>/mcp"}` with the address it bound and the port it used. Use that URL
verbatim.

- `hermes.mcp.port` is pi-spore's setting for this port: an integer 1 to 65535, global, **default 7430**. Use the
  resolved value, not the default, if the user changed it.
- The listener runs only while **both** `hermes.enabled` and `hermes.mcp.enabled` are `true`. `hermes.mcp.enabled`
  defaults to `false`. With no Tailscale address on the desktop the listener does not start, and pi-spore's log says
  why.

## Allow the four tools for this profile's API sessions

The profile's API toolsets are `terminal` and `clarify` only
([hermes-pi-spore-profile.md](../../spikes/hermes-pi-spore-profile.md)). Hermes' docs say each configured MCP server
makes an `mcp-<server>` toolset, and that in `platform_toolsets.<platform>` a list that names **no** MCP server gets
**every** enabled server, while a list that names servers gets only those
([Hermes: Toolsets](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)).

Read the current state first. Both commands are profile-scoped:

```bash
docker exec <container> hermes -p pi-spore tools list --platform api_server
docker exec <container> hermes -p pi-spore config get platform_toolsets
```

`hermes tools list --platform <p>` prints the built-in toolsets enabled for that platform and each MCP server with its
include or exclude filter, so it is the read-back for this step. If the platform name is wrong, the CLI names the
valid ones (`Unknown platform '<p>'. Valid: …`) — use what it prints, and record it.

**The enabling mechanism is unresolved, on purpose.** Verified against Hermes v0.23.3
(`hermes_cli/tools_config_mcp.py`, `tools_disable_enable_command`):

- a bare name is checked against the configurable built-in and plugin toolsets, so `hermes tools enable pi_spore
  --platform <p>` fails with `Unknown toolset 'pi_spore'`. **Do not run it as the enabling step** — an earlier draft of
  this doc named that command, and it does not work.
- a `server:tool` name goes to the per-server filter instead: it edits `mcp_servers.<server>.tools.exclude`. That is
  the same filter this card already writes by hand, so it adds nothing here.
- so no `hermes tools` subcommand adds a native MCP server to a platform's toolset list. The documented place for that
  list is `platform_toolsets.<platform>` in `config.yaml`, and this lane cannot verify the exact key and saved shape on
  this build.

Work out what this profile actually needs from the read-back, then choose:

- **If the four `mcp__pi_spore__*` tools already appear for a `pi-spore` API session** — which the "names no MCP server
  gets every enabled server" rule predicts while `pi_spore` is the only server configured — **change nothing**.
  Record that in the evidence line: no toolset change, and the reason.
- **If they do not appear, or the profile gains another MCP server later**, then the list has to name `pi_spore` and
  nothing else. Edit `config.yaml` under the platform key the read-back showed, with the three toolsets this profile is
  allowed: `terminal`, `clarify`, `pi_spore`. Read it back with both commands above, and add nothing else: no `file`,
  no `browser`, no `code_execution`, no `kanban`, no `connections`. **Check before applying**: the key name and the
  saved shape come from this build, not from this doc. If neither the docs' key nor the CLI produces a list with those
  three, stop and record what the build offers instead of guessing.

Either way, the authority is step S6's tool list for a real `pi-spore` API session: the four
`mcp__pi_spore__*` tools present, and no other `mcp__*` tool.

## Reload, and confirm the load

Every Hermes command in this card carries `-p pi-spore`. A bare `hermes mcp` reads the **default** profile, not
`pi-spore`, and it is the catalog and configuration picker rather than a connection report — so it cannot be evidence
that this profile loaded four tools.

```bash
docker exec <container> hermes -p pi-spore config get mcp_servers.pi_spore
docker exec <container> hermes -p pi-spore tools list --platform api_server
docker exec <container> hermes gateway status
```

The running gateway watches `config.yaml` on its own: a removed entry is torn down and a new one connects within about
a minute. In a running session, `/reload-mcp` reconnects the MCP servers. `docker exec <container> hermes gateway
restart` also works, and is the command the spike used.

Two separate pieces of evidence, and both belong in the runbook:

1. **The saved config**, from the two commands above: the entry is there with `${env:PI_SPORE_MCP_TOKEN}` and the four
   `tools.include` names, and the platform read-back shows what API sessions get.
2. **The live connection, on this profile.** Ask a `pi-spore` session to list its tools, or use the in-session
   `/tools list`, and expect exactly `mcp__pi_spore__list_targets`, `mcp__pi_spore__submit_request`,
   `mcp__pi_spore__get_request`, `mcp__pi_spore__cancel_request` and no other `mcp__*` name. The decisive proof is
   step S6's first call: `mcp__pi_spore__list_targets` answers from inside a `pi-spore` run, which only happens if the
   connect and the load both worked. If the connect failed, `docker exec <container> hermes logs --level debug` shows
   the endpoint each attempt used.

## What the listener accepts, so a failure reads clearly

From the merged code. `POST` the JSON-RPC message to `/mcp` with `Content-Type: application/json`; one message per
request; the answer is one JSON body (no SSE, no session id). A message with no `id` (a notification) gets `202`.

| Situation | Answer |
| --- | --- |
| `Host` is not the listener's own `<ip>:<port>` | `403 bad_host` |
| Any `Origin` header | `403 bad_origin` |
| Missing or wrong bearer token, or pi-spore's user or agent token | `401 unauthorized` (with `WWW-Authenticate: Bearer`) |
| `hermes.enabled` or `hermes.mcp.enabled` is off, in the short window before the settings check runs | `503 mcp_off` |
| The token file went bad while the listener was open | `503 mcp_token_unusable` |
| Any path but `/mcp` | `404 not_found` |
| `GET`, or any method but `POST` | `405` with `Allow: POST` |
| `Content-Type` not `application/json` | `415 bad_content_type` |
| Body over 64 KiB | `413 body_too_large` |
| Over 120 requests a minute | `429 rate_limited` |
| Methods other than `initialize`, `ping`, `tools/list`, `tools/call` | JSON-RPC `-32601` |

Methods answered: `initialize`, `ping`, `tools/list`, `tools/call`. Protocol revisions echoed back if offered:
`2025-11-25`, `2025-06-18`, `2025-03-26`; otherwise the newest.

**Off means closed, not `503`.** `GET /api/hermes/mcp` runs the same settings check, and when a gate is off that check
closes the server. So once a setting is off — or the token file was never good, in which case the listener never
opened — a client gets "connection refused", and `503 mcp_off` only appears in the moments between the change and the
check that closes the port. Read "the port does not answer" as "off or not ours", and use the listener state on the
pi-spore Settings page to tell which.

**A tool that refuses is not an HTTP error.** A `tools/call` whose handler raises comes back as **HTTP 200** with a
JSON-RPC result of `isError: true` and one text item holding the message. The internal error code and status are not
sent. So `hop_count` above 0, a `request_id` reused with a different body, and a target outside
`hermes.inbound.projects` all read as a failed tool call whose text says why — not as `403` or `409`. Only the guards
in the table above, which run before any tool, answer with an HTTP status.

## Three things to watch when S4 is applied

- **Plain HTTP to a non-loopback host.** The entry is `http://`, not `https://`: the transport is the tailnet, and
  the desktop has no certificate. Hermes' portable-plugin rules accept plain HTTP only for loopback hosts, and the
  docs do not say whether the native `mcp_servers` path applies the same bound. If the connect is refused for a plain
  HTTP URL, **stop**: this design has no other option inside the rules (no Funnel, no Serve, no SSH), so the user
  decides. Card Hermes 1.5 proves it.
- **A preflight probe.** Hermes fail-fasts on an endpoint whose `HEAD`/`GET` answer is not an MCP content type. This
  listener answers `405` with no body. If the connect dies there, set `skip_preflight: true` on the entry — the docs
  give exactly that key for a valid Streamable HTTP endpoint. **Check before applying**: this build's behaviour is
  unproven; `docker exec <container> hermes logs --level debug` shows the endpoint and the failure.
- **`trust` stays at its default (`full`).** With `trust: untrusted`, every write-capable tool of this server needs a
  Hermes approval first, and this profile runs `approvals.mode: manual` with `unattended_mode: deny` — an API session
  with nobody at a prompt would deny its own requests, so the setting would break the integration without adding a
  gate that matters. The gate that matters is on pi-spore: a new request does nothing until the user accepts it on
  Home. That does **not** make the token or these tools harmless — `list_targets`, `get_request`, and `cancel_request`
  disclose and act without any acceptance, as [token-delivery.md](token-delivery.md) spells out. The point is only that
  a Hermes-side approval prompt would not catch what a leaked token can do. Do not set `trust`.

## Rollback

Step S4 only, in [runbook.md](runbook.md#rollback):

```bash
docker exec <container> hermes -p pi-spore config unset mcp_servers.pi_spore   # check before applying: the unset form
# or edit /opt/data/profiles/pi-spore/config.yaml and delete the pi_spore block
docker exec <container> hermes -p pi-spore config get mcp_servers
```

Removing the entry takes the tools away; the token on Unraid and the grant are removed in the other rollback steps.
