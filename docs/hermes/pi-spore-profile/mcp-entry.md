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
([hermes-pi-spore-profile.md](../../spikes/hermes-pi-spore-profile.md)). Each configured MCP server makes a
`mcp-<server>` toolset, and in `platform_toolsets.<platform>` a list that names no MCP server gets **every** enabled
server — so naming this one is the narrow choice: it adds only `pi_spore` and keeps any server added later out of API
sessions ([Hermes: Toolsets](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)).

```bash
docker exec <container> hermes -p pi-spore tools enable pi_spore --platform api_server
docker exec <container> hermes -p pi-spore config get platform_toolsets
```

**Check before applying.** Hermes documents `hermes tools enable <tool> --platform <p>` and the `hermes tools`
selection UI; the exact platform key for the API server (`api_server` or `api`) and the saved shape of
`platform_toolsets` are not proven by the spike docs. Run `hermes -p pi-spore tools --help` first, then read the
result back with the `config get` above and paste it in the evidence. The check that matters is the evidence run in
step S6: the four `pi_spore` tools are listed for a `pi-spore` API session, and no other MCP tool is.

Keep `terminal` and `clarify` as they are, and add nothing else: no `file`, no `browser`, no `code_execution`, no
`kanban`, no `connections`.

## Reload, and confirm the load

```bash
# The running gateway watches config.yaml; a session picks the change up on reload.
docker exec <container> hermes -p pi-spore config get mcp_servers.pi_spore
docker exec <container> hermes mcp            # status picker: pi_spore connected, 4 tools
docker exec <container> hermes gateway status
```

In a running session, `/reload-mcp` reconnects MCP servers. A gateway restart also works
(`docker exec <container> hermes gateway restart`), and is the command the spike used.

Expected: `pi_spore` connected with exactly four tools — `mcp__pi_spore__list_targets`,
`mcp__pi_spore__submit_request`, `mcp__pi_spore__get_request`, `mcp__pi_spore__cancel_request`. Record the tool list,
redacted, in the runbook's evidence table.

## What the listener accepts, so a failure reads clearly

From the merged code. `POST` the JSON-RPC message to `/mcp` with `Content-Type: application/json`; one message per
request; the answer is one JSON body (no SSE, no session id). A message with no `id` (a notification) gets `202`.

| Situation | Answer |
| --- | --- |
| `Host` is not the listener's own `<ip>:<port>` | `403 bad_host` |
| Any `Origin` header | `403 bad_origin` |
| Missing or wrong bearer token, or pi-spore's user or agent token | `401 unauthorized` (with `WWW-Authenticate: Bearer`) |
| `hermes.enabled` or `hermes.mcp.enabled` is off | `503 mcp_off` |
| The token file is missing, unreadable, too open, or empty | `503 mcp_token_unusable` |
| Any path but `/mcp` | `404 not_found` |
| `GET`, or any method but `POST` | `405` with `Allow: POST` |
| `Content-Type` not `application/json` | `415 bad_content_type` |
| Body over 64 KiB | `413 body_too_large` |
| Over 120 requests a minute | `429 rate_limited` |
| Methods other than `initialize`, `ping`, `tools/list`, `tools/call` | JSON-RPC `-32601` |

Methods answered: `initialize`, `ping`, `tools/list`, `tools/call`. Protocol revisions echoed back if offered:
`2025-11-25`, `2025-06-18`, `2025-03-26`; otherwise the newest.

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
- **`trust` stays at its default (`full`).** With `trust: untrusted`, every write-capable tool of the server needs a
  Hermes approval first, and this profile has `unattended_mode: deny` — an API session with nobody at a prompt would
  deny its own requests. The four tools are harmless until the user accepts a request in pi-spore, which is the real
  gate, so the narrow trust setting is not needed here. Do not set `trust`.

## Rollback

Step S4 only, in [runbook.md](runbook.md#rollback):

```bash
docker exec <container> hermes -p pi-spore config unset mcp_servers.pi_spore   # check before applying: the unset form
# or edit /opt/data/profiles/pi-spore/config.yaml and delete the pi_spore block
docker exec <container> hermes -p pi-spore config get mcp_servers
```

Removing the entry takes the tools away; the token on Unraid and the grant are removed in the other rollback steps.
