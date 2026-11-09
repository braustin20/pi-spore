# 0143. A phone reaches pi-spore through `tailscale serve`, checked by Tailscale login

- Status: Accepted
- Date: 2026-11-09
- Requirements: R1.1, R1.2

## Context

- The user wants to open pi-spore on a phone over their tailnet.
- The server binds `127.0.0.1` (R1.2). A Host guard answers 403 `bad_host` to any Host that is not loopback, and the
  WebSocket guard checks Host and Origin the same way. This stops DNS rebinding.
- The page at `/` carries the API token in a meta tag. Whoever loads the page gets the token. The terminals module
  gives a shell and agents run code, so a leaked token is a remote shell on the user's machine. This is the main
  risk.
- `tailscale serve --bg 7420` runs in `tailscaled` on the same machine. It answers HTTPS on
  `https://<machine>.<tailnet>.ts.net/` to the tailnet only and proxies to `http://127.0.0.1:7420`. `--bg` keeps the
  setup across reboots. It needs MagicDNS and HTTPS certificates on the tailnet
  ([kb/1312](https://tailscale.com/kb/1312/serve), [kb/1242](https://tailscale.com/kb/1242/tailscale-serve)).
- What the backend sees from serve: the original `*.ts.net` Host, the browser's Origin, a TCP peer of `127.0.0.1`,
  and `Tailscale-User-Login`. Serve removes any `Tailscale-User-*` header the client sent and sets its own from the
  tailnet identity, so a tailnet client cannot forge it. Serve sets no identity headers for tagged devices, for
  Funnel traffic, or for requests from the serving machine itself.
- Funnel publishes a port to the public internet. It has no place here.

## Decision

- The bind stays on `127.0.0.1`. pi-spore never listens on `0.0.0.0` or on a Tailscale address.
- The user runs `tailscale serve --bg <port>` once. pi-spore never runs `tailscale`, and never sets up or uses
  Funnel. `pi-spore remote` prints the command and the URL to open.
- Two global settings in `~/.pi-spore/settings.json`, read once at startup (restart to change):
  - `server.allowedHosts`: host names, such as `box.tail1234.ts.net`. Default empty.
  - `server.allowedLogins`: Tailscale logins, such as `me@example.com`. Default empty.
  - Hosts set and logins empty stops startup with an error that names both settings.
- One guard, `guardRequest` in `packages/server-core/src/guards.ts`, checks every HTTP request (the page, static
  files, `/api/health`, `/api/*`) and every WebSocket upgrade, before the token check:
  1. The TCP peer must be loopback, or 403 `bad_peer`. A peer from another machine skipped serve, so its headers
     could be forged.
  2. A loopback Host passes, as before.
  3. A Host in `server.allowedHosts` needs a `Tailscale-User-Login` that is exactly one of `server.allowedLogins`,
     or 401 `identity_required`. So the page with the token is served only to a listed login.
  4. Any other Host is 403 `bad_host`.
  5. Upgrades only: the Origin must be absent, loopback, or `https://<an allowed host>`, or 403 `bad_origin`.
- `/api/*` still needs the token after the guard. The CLI keeps working on loopback with the token file.
- The token is never logged. A login is logged by name only.
- We chose the Tailscale login over a pairing code (`pi-spore pair`, a code traded for a cookie). The login needs no
  new state, page, or expiry, and Tailscale already proves who the user is. A pairing code would add a code store,
  cookies, expiry, and revoke: more code, more to get wrong.

## Consequences

- Empty settings behave exactly as before.
- A tagged device gets no login header, so it is refused. Use a device logged in as the user.
- Any process on this machine can call `127.0.0.1:7420` with a forged login header. That grants nothing new: such a
  process can already load `/` on a loopback Host and read the token.
- R1.2 now allows named tailnet hosts through `tailscale serve`. The "mobile layout" line in the vision now says a
  phone may reach the UI; a layout made for phones is still not planned.
- WebSockets through serve over HTTP/2 have an open Tailscale issue (#20882). The user tests live updates and a
  terminal on the phone.
