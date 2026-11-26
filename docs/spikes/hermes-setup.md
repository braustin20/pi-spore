# Spike Hermes 0.1: Hermes API server on Unraid, reachable from the desktop over Tailscale only

> Amended 2026-11-26: see [hermes-pi-spore-profile.md](hermes-pi-spore-profile.md).

- Date: 2026-11-25
- Hermes: v0.23.4 (the newest release on 2026-11-25), official Docker image `nousresearch/hermes-agent`.
- Question: can the desktop reach the Hermes HTTP API server of profile `homelab-maintainer` on Unraid over
  Tailscale, while nothing else can reach it?
- Method: the user applies this runbook by hand on both machines, then pastes the evidence into
  [Evidence](#evidence). No agent changes Docker, Hermes config, Tailscale, firewall, or pi-spore settings.
- Status: **runbook written, not yet applied.** No later card may claim live proof until [Evidence](#evidence) is
  filled in.

## Decisions this runbook follows

- No SSH from the desktop to Unraid for pi-spore. Add no SSH keys or accounts.
- No TLS in Hermes. Tailscale (WireGuard) encrypts the traffic.
- No WAN port forward. No Tailscale Funnel. No Tailscale Serve.
- A tailnet-only listener on the desktop (Unraid to desktop) is a later fallback for card Hermes 1.4. It is not set
  up here.

## What changed in Hermes since the card was written

The card planned a separate API port per profile. Hermes v0.23 works differently:

- **One gateway serves all profiles** ("multiplexing"). It is on by default. `gateway.multiplex_profiles: false` is
  retired.
- A named profile does not get its own API listener. Its API is at `/p/<profile>/v1/...` on the **default
  profile's** API server port.
- Each profile still has its own key. A request to `/p/homelab-maintainer/v1/...` must carry the key from
  `profiles/homelab-maintainer/.env`. The default profile's key is refused there (`401`).
- A profile with no `API_SERVER_KEY` of its own fails closed. Its prefix is unreachable.
- A named profile must **not** set `API_SERVER_ENABLED` itself. Its `API_SERVER_KEY` only wires the credential.
- A per-profile gateway with its own port still works with `gateway.standalone: true`, but Hermes calls it a
  temporary shim that it will remove. See [Fallback: standalone profile](#fallback-standalone-profile).

So this runbook turns on the default profile's API listener, gives only `homelab-maintainer` a profile key, and
uses the URL `http://<unraid-ts-name>:8642/p/homelab-maintainer/v1/...`. The default profile's own key never leaves
Unraid.

## Placeholders

Replace these everywhere below. Do not put real values in this file, except where [Evidence](#evidence) asks.

| Placeholder | Meaning | How to find it |
|---|---|---|
| `<hermes-data>` | Unraid host folder mounted at `/opt/data` in the container | Container template, volume for `/opt/data` (often `/mnt/user/appdata/hermes`) |
| `<container>` | Name of the Hermes container | `docker ps` on Unraid (often `hermes`) |
| `<unraid-ts-ip>` | Unraid's Tailscale IPv4 address (`100.x.y.z`) | `tailscale ip -4` on Unraid |
| `<unraid-ts-name>` | Unraid's MagicDNS name | `tailscale status` on the desktop |
| `<desktop-ts-ip>` | The desktop's Tailscale IPv4 address | `tailscale ip -4` on the desktop |
| `<unraid-lan-ip>` | Unraid's LAN address (for the negative test) | Unraid web UI, or `ip -4 addr` |

## Part 1: Unraid and Hermes

### 1.1 Check the starting point

Run on Unraid:

```sh
docker exec <container> hermes --version
docker inspect -f '{{.Config.Image}} {{.HostConfig.NetworkMode}}' <container>
docker port <container>
docker exec <container> hermes profile list
```

- The network mode must be `bridge` or a named bridge network, **not** `host`. With `host`, every `0.0.0.0` bind
  in the container is a LAN bind, and this runbook does not apply. Stop and ask.
- Note every port that `docker port` lists. After this runbook, only one must remain (step 1.5).
- `homelab-maintainer` must be in the profile list.

Check that the container template sets no `API_SERVER_*` variables container-wide. Container variables reach every
profile, and `-e` values override `.env` files:

```sh
docker exec <container> env | grep -E '^(API_SERVER_|HERMES_YOLO_MODE|HERMES_DASHBOARD|GATEWAY_MULTIPLEX)' | sed 's/=.*/=<set>/'
```

Expected: no `API_SERVER_*` line and no `HERMES_YOLO_MODE` line. If there are any, remove them from the Unraid
container template first. If `HERMES_DASHBOARD` is set, see step 1.6.

### 1.2 Turn on the API listener (default profile)

The default profile's API server is the one listener for all profiles. Its key stays on Unraid and is never used
by the desktop.

Run on Unraid. The key is written straight to the file and never shown:

```sh
ls -ln <hermes-data>/.env      # note the owner and mode; keep them the same after the edit
cat >> <hermes-data>/.env <<'EOF'
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
EOF
printf 'API_SERVER_KEY=%s\n' "$(openssl rand -hex 32)" >> <hermes-data>/.env
ls -ln <hermes-data>/.env      # same owner and mode as before
```

- `API_SERVER_HOST=0.0.0.0` is the bind **inside the container's own network**. Docker needs it to forward a
  published port. The host side is limited to the Tailscale address in step 1.5. The host never binds `0.0.0.0`.
- Do not set `API_SERVER_CORS_ORIGINS`. pi-spore calls Hermes from its server, not from a browser.
- If `<hermes-data>/.env` already had `API_SERVER_*` lines, edit them instead of adding duplicates.

### 1.3 Give `homelab-maintainer` its own key

Generate the key on the desktop first (step 2.1). Then add it to the profile's `.env` on Unraid. Type or paste it
at the hidden prompt, so it stays out of the shell history and off the screen:

```sh
ls -ln <hermes-data>/profiles/homelab-maintainer/.env
read -rs HM_KEY
printf 'API_SERVER_KEY=%s\n' "$HM_KEY" >> <hermes-data>/profiles/homelab-maintainer/.env
unset HM_KEY
ls -ln <hermes-data>/profiles/homelab-maintainer/.env   # same owner and mode as before
```

- Do **not** add `API_SERVER_ENABLED`, `API_SERVER_PORT`, or `API_SERVER_HOST` to this profile's `.env`.
- If you paste through the Unraid web terminal, check the key afterwards: browser consoles can garble characters.
  A hex key (`0-9a-f`) is safe. Compare the last 4 characters only:
  `grep '^API_SERVER_KEY=' <hermes-data>/profiles/homelab-maintainer/.env | tail -c 5`.

Check that no other named profile has an API key. Any named profile with a key is reachable under its own prefix:

```sh
grep -l '^API_SERVER_KEY=' <hermes-data>/profiles/*/.env
```

Expected: only `<hermes-data>/profiles/homelab-maintainer/.env`. Remove the key from any other profile you do not
want reachable.

### 1.4 Approvals for `homelab-maintainer`

Dangerous shell commands need a human yes. Set this in the profile's own config:

```sh
docker exec <container> hermes -p homelab-maintainer config set approvals.mode manual
docker exec <container> hermes -p homelab-maintainer config set approvals.unattended_mode deny
docker exec <container> hermes -p homelab-maintainer config get approvals
```

- `manual` asks for every dangerous command. `smart` (the default) is also allowed; it lets a model clear
  low-risk matches. Never use `off`.
- Never set `HERMES_YOLO_MODE`, never start Hermes with `--yolo`, never send `/yolo` to this profile.
- `unattended_mode` decides what `api_server` sessions do when a dangerous command needs approval:
  - `deny` (the default, use this): the command is blocked at once, and the agent must find another way.
  - `approve`: every dangerous command runs without asking. Never use it.
  - Exception: on `/v1/runs` and on streaming chat completions, the client can answer, so Hermes still sends the
    approval request. The client answers with `POST /v1/runs/{run_id}/approval`. pi-spore will use this path later
    to put the approval in front of the user.
- The same rules gate `execute_code` scripts: an API session asks once for the whole script, or `deny` blocks it.
- Under multiplexing, each turn uses the routed profile's own config, so these settings apply to
  `/p/homelab-maintainer/...` requests.

Restart the gateway, then check that it serves the profile:

```sh
docker exec <container> hermes gateway restart
docker exec <container> hermes gateway status
```

Expected: the status lists `homelab-maintainer` as a served profile, and the API server is up on port 8642. If the
profile is not served, the status names the blocker. Fix it, or use the
[fallback](#fallback-standalone-profile).

Check from Unraid itself (inside the container; this proves Hermes works before the network part):

```sh
docker exec <container> curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8642/p/homelab-maintainer/v1/capabilities
```

Expected: `401` (no key sent). If `curl` is not in the image, skip this check.

### 1.5 Publish port 8642 on the Tailscale address only

In the Unraid container template:

1. Remove any port mapping for 8642 that has no host IP (it would bind `0.0.0.0` on the host, which includes the
   LAN).
2. Add this to **Extra Parameters** (Advanced view):

   ```text
   -p <unraid-ts-ip>:8642:8642
   ```

3. Apply. Unraid recreates the container. The data in `<hermes-data>` stays.

Then check on Unraid:

```sh
docker port <container>
ss -ltnp | grep -E ':(8642|9119|9120)\b'
```

Expected: one line, `8642/tcp -> <unraid-ts-ip>:8642`. `ss` shows `<unraid-ts-ip>:8642` only. No `0.0.0.0`, no
`[::]`, no LAN address, no 9119 or 9120.

Boot order: the bind needs the Tailscale address to exist. If Docker starts the container before Tailscale is up
after a reboot, the container fails with "cannot assign requested address". After a reboot, check that the container
runs. If it does not, start it again once `tailscale ip -4` answers.

Alternative: run Tailscale for the container (Unraid's per-container Tailscale option, or a Tailscale sidecar).
Then publish no port at all, and use the container's own tailnet name and IP in place of `<unraid-ts-name>` and
`<unraid-ts-ip>`. The ACL in step 1.7 then targets that node. This runbook does not cover that setup in detail.

### 1.6 Keep the dashboard, the Webapp, and the gateway WebSocket local

- Dashboard (port 9119): leave `HERMES_DASHBOARD` unset. If you use it, set `HERMES_DASHBOARD_HOST=127.0.0.1` and
  do not publish 9119. Reach it some other way (for example the Unraid console), not from pi-spore.
- Webapp (port 9120): leave `webapp.enabled` off, and do not publish 9120.
- Gateway WebSocket (`/api/ws`): it is for local clients (TUI, Desktop on the same host) and needs a single-use
  ticket from `hermes gateway attach` on the host. Do not set up remote access to it. The docs do not say whether it
  shares port 8642, so step 3 checks that it does not answer from the desktop.

### 1.7 Tailscale access rule

In the Tailscale admin console, edit the tailnet policy file. This example lets only the desktop reach port 8642 on
Unraid. The `tests` block makes the console refuse to save a policy that breaks this.

```jsonc
{
  "hosts": {
    "desktop": "<desktop-ts-ip>",
    "unraid": "<unraid-ts-ip>"
  },
  "grants": [
    // Only the desktop may reach the Hermes API on Unraid.
    { "src": ["desktop"], "dst": ["unraid"], "ip": ["tcp:8642"] }
    // ... your other rules ...
  ],
  "tests": [
    { "src": "desktop", "accept": ["unraid:8642"] },
    // Repeat for each other tailnet device or user you have, for example a phone:
    { "src": "<other-user-or-device>", "deny": ["unraid:8642"] }
  ]
}
```

- Grants add up. A broad rule elsewhere, such as the default allow-all
  `{ "src": ["*"], "dst": ["*"], "ip": ["*"] }`, also opens 8642 to every device. Replace it with rules that name
  the ports other devices really need on Unraid, or the `deny` tests fail.
- If your policy uses the older `acls` section, the same rule is
  `{ "action": "accept", "src": ["desktop"], "dst": ["unraid:8642"] }`.
- If the desktop's Tailscale IP changes (for example after it is removed and added again), update `hosts`.

### 1.8 No Funnel, no Serve, no WAN forward

On Unraid and on the desktop:

```sh
tailscale funnel status
tailscale serve status
```

Expected on both: no Funnel and no Serve configuration. On the router: no port forward to Unraid port 8642.

## Part 2: The desktop

### 2.1 Make and store the key

Run on the desktop as your own user (not root):

```sh
install -d -m 700 ~/.pi-spore/hermes
( umask 077 && openssl rand -hex 32 > ~/.pi-spore/hermes/homelab-maintainer.key )
ls -l ~/.pi-spore/hermes/
```

Expected: `-rw-------` and your user as owner. Show the key once to copy it into step 1.3
(`cat ~/.pi-spore/hermes/homelab-maintainer.key`), then clear the terminal and its scrollback.

Rules for this key:

- It lives only in `~/.pi-spore/hermes/homelab-maintainer.key` on the desktop and in
  `<hermes-data>/profiles/homelab-maintainer/.env` on Unraid.
- It never goes into `settings.json`, a repo, a prompt, a chat, a log, or this doc.
- Never copy pi-spore's own user token (`~/.pi-spore/token`) to Unraid. It is a different secret for a different
  purpose.

### 2.2 How to send the key in commands

The commands below build the header with `printf`, a shell builtin. This keeps the key out of `ps`, out of the shell
history, and off the screen:

```sh
hm_auth() { printf 'Authorization: Bearer %s\n' "$(cat ~/.pi-spore/hermes/homelab-maintainer.key)"; }
```

## Part 3: Checks and evidence

Run each check and paste the output into [Evidence](#evidence). Never paste a key. If an output shows a key, replace
it with `<redacted>`.

From the desktop:

```sh
# 1. With the key: expect HTTP 200 and a "features" object.
curl -sS -H @<(hm_auth) -w '\nHTTP %{http_code}\n' \
  http://<unraid-ts-name>:8642/p/homelab-maintainer/v1/capabilities

# 2. No key: expect HTTP 401.
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://<unraid-ts-name>:8642/p/homelab-maintainer/v1/capabilities

# 3. Gateway WebSocket path from the desktop, no key: expect a 4xx code, never 101.
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://<unraid-ts-name>:8642/api/ws

# 4. Dashboard and Webapp ports: expect "refused" or a timeout.
nc -zv -w 5 <unraid-ts-name> 9119
nc -zv -w 5 <unraid-ts-name> 9120

# 5. No Funnel on the desktop.
tailscale funnel status

# 6. Key file mode: expect -rw------- and your user.
ls -l ~/.pi-spore/hermes/
```

From a LAN machine that is **not** on the tailnet:

```sh
# 7. Expect a timeout or "refused". It must not connect.
nc -zv -w 5 <unraid-lan-ip> 8642
```

From another tailnet device that is not the desktop (for example a phone with a terminal app, or a laptop):

```sh
# 8. Expect a timeout. Tailscale drops the packets.
nc -zv -w 5 <unraid-ts-name> 8642
```

On Unraid:

```sh
# 9. Version.
docker exec <container> hermes --version

# 10. Only the Tailscale bind is published.
docker port <container>

# 11. No Funnel on Unraid.
tailscale funnel status
```

## Evidence

Status: **not yet collected.** Fill in each item. If you cannot collect an item, write why. If items are missing,
the card stays blocked and lists them.

| # | Check | Expected | Result (paste, key redacted) |
|---|---|---|---|
| 9 | `hermes --version` in the container | v0.23.x or newer | |
| 1 | `capabilities` with key | `HTTP 200` and a `features` object | |
| 2 | `capabilities` without key | `HTTP 401` | |
| 3 | `/api/ws` from the desktop | a `4xx` code, never `101` | |
| 4 | Ports 9119 and 9120 from the desktop | refused or timeout | |
| 7 | Port 8642 from a LAN machine off the tailnet | refused or timeout | |
| 8 | Port 8642 from another tailnet device | timeout | |
| 5, 11 | `tailscale funnel status` on both machines | no Funnel | |
| 10 | `docker port <container>` | only `8642/tcp -> <unraid-ts-ip>:8642` | |
| 6 | `ls -l ~/.pi-spore/hermes/` | `-rw-------`, owner is the user | |

Date collected:

## Rollback

Do these in order. Each step closes access on its own.

1. Tailscale policy: remove the grant, the `hosts` entries, and the `tests` from step 1.7, then save.
2. Unraid container template: remove `-p <unraid-ts-ip>:8642:8642` from Extra Parameters, then apply.
3. Turn the API server off:

   ```sh
   sed -i 's/^API_SERVER_ENABLED=true$/API_SERVER_ENABLED=false/' <hermes-data>/.env
   sed -i '/^API_SERVER_KEY=/d' <hermes-data>/profiles/homelab-maintainer/.env
   docker exec <container> hermes gateway restart
   ```

4. Desktop: `rm ~/.pi-spore/hermes/homelab-maintainer.key`.
5. Check from the desktop: check 1 in Part 3 must fail to connect.

To rotate the key instead, make a new one (step 2.1), replace the line in the profile's `.env` (step 1.3, after
deleting the old line), and restart the gateway.

## Fallback: standalone profile

Use this only if the gateway does not serve `homelab-maintainer` under multiplexing and the blocker cannot be fixed.
Hermes says `gateway.standalone` is a temporary shim and will be removed in a later release, with notice in the
release notes.

Differences from the main path:

- Do not turn on the default profile's API server (skip step 1.2).
- In `<hermes-data>/profiles/homelab-maintainer/config.yaml`, set `gateway: { standalone: true }`.
- In `<hermes-data>/profiles/homelab-maintainer/.env`, set `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`,
  `API_SERVER_PORT=8643`, and the key from step 1.3.
- Start it: `docker exec <container> hermes -p homelab-maintainer gateway start`.
- Publish `-p <unraid-ts-ip>:8643:8643`, use `tcp:8643` in the grant and tests, and use port 8643 in every check.
- The URL has no prefix: `http://<unraid-ts-name>:8643/v1/capabilities`.

## Sources

Read 2026-11-25:

- API server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Docker: https://hermes-agent.nousresearch.com/docs/user-guide/docker
- Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- Multiplexing (`/p/<profile>/`, `gateway.standalone`):
  https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways
- Approvals (`approvals.mode`, `unattended_mode`, YOLO): https://hermes-agent.nousresearch.com/docs/user-guide/security
- Gateway WebSocket (`/api/ws`, tickets): https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-ssh-clients
- Release v0.23.4 (2026-11-23): https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.4
- Tailscale policy file (grants, hosts, tests): https://tailscale.com/docs/reference/syntax/policy-file
