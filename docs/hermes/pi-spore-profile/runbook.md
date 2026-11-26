# Runbook: give the Hermes profile `pi-spore` its skill, its MCP entry, and its rule

Card Hermes 1.4, [ADR 0202](../../decisions/0202-hermes-remote-teammate.md) §8, §9, §10, §12. The code side is merged:
the MCP listener and requests from Hermes (card Hermes 1.3, `modules/hermes/src/mcp/listener.ts`,
`modules/hermes/src/inbound.ts`).

**Status: nothing applied.** Every live step below is pending: it needs the user's yes first, and an evidence line
after. This runbook is the record of both.

## How to use this

- No agent applies any of it on its own. The user applies each step — the Unraid and Hermes parts through Homelab
  Maintainer, the Tailscale part in the Tailscale console, the desktop parts directly. ADR 0202 §10 names the network
  rule and the `mcp_servers` entry as steps that each need an explicit yes; the same rule covers every other step here,
  because each changes a live system.
- Get the yes **before** the step, and write it in that step's "Yes" table. Then run the step, then write the redacted
  result in its "Evidence" table. Redact: no token, no key, no full ciphertext, no `Authorization` value, no host path
  that holds a secret.
- Where a Hermes command or config key is not proven by the spike docs or the Hermes docs, the text says
  **check before applying**. Confirm it with a read-back command first; if it does not exist as written, stop and
  record what the build does instead. Do not guess silently.
- If a step is not done, the card stays blocked and names it. Name the step (`S3`, not "the network thing").

## Before you start

| Item | Expected | Where |
| --- | --- | --- |
| pi-spore code | Cards Hermes 1.1, 1.2, 1.3 merged | this repo |
| Hermes version | `0.23.3` (the tested minor `0.23.x`) | `docker exec <container> hermes --version` |
| Profile | `pi-spore` exists, with its own key working on `/p/pi-spore` | [hermes-pi-spore-profile.md](../../spikes/hermes-pi-spore-profile.md) |
| Approvals on `pi-spore` | `approvals.mode: manual`, `unattended_mode: deny`, `command_allowlist: []` | `docker exec <container> hermes -p pi-spore config get approvals` |
| API toolsets | `terminal` and `clarify` only | step S4 reads the result back |
| Inbound targets | `hermes.inbound.projects` lists the project ids the user wants reachable. Empty, the default, means `list_targets` is empty and every submit is refused `target_not_allowed` | pi-spore Settings |
| Names and values | `<desktop-tailscale-ip>`, `<hermes.mcp.port>`, `<container>`, `<hermes-data>` filled in by the operator | not in this repo |

Never change the approvals settings for this or any profile as part of this card: never `off`, never YOLO, never an
allowlist entry. `manual` plus `unattended_mode: deny` is what makes an unattended Hermes run unable to run a flagged
command. If a step seems to need it, stop.

## S1 — Desktop: the MCP token file, and turn the listener on

Needs the user's yes. Writes `~/.pi-spore/hermes/mcp.token` and changes two pi-spore settings.

Commands in [token-delivery.md](token-delivery.md#s1-desktop-make-the-token). Then, in pi-spore:

- Settings, global scope: `hermes.mcp.enabled` to `true` (it defaults to `false`). `hermes.enabled` must already be
  `true` for the connector, and `hermes.mcp.port` keeps its resolved value (default `7430`). Reload on the Settings
  page checks the listener at once, without a restart.
- The Settings page shows the listener state. Its URL, or the same shape from `GET /api/hermes/mcp` (the user token,
  loopback only — never put that token in a command argument), is what S2 and S4 use.

Expected: `{"state":"listening","url":"http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp"}` — use that URL verbatim
in S2 and S4. `{"state":"failed", ...}` names the cause: no Tailscale address on the desktop, or an unreadable token
file. Both are S1 failures, not S4 mysteries. The listener answers nothing until the token file is good.

| Yes | Record |
| --- | --- |
| Who asked, when, and the user's answer | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Token file modes | `ls -lnd ~/.pi-spore/hermes`, `ls -ln ~/.pi-spore/hermes/mcp.token` | pending: needs the user's yes |
| Listener state | the `GET /api/hermes/mcp` answer above, URL only | pending: needs the user's yes |

## S2 — Unraid: the token arrives in the profile's `.env`

Needs the user's yes. Two sub-steps, each with its own yes line, because they run on different machines: the pair and
the write on Unraid, the encrypt-and-send on the desktop.

Commands in [token-delivery.md](token-delivery.md#s2-unraid-a-receiving-key-pair-then-the-token). Nothing is printed
at any point; only the base64 ciphertext and its SHA-256 cross the wire, as chat text.

| Yes | Record |
| --- | --- |
| S2a Unraid key pair, S2b desktop encrypt, S2c Unraid write: the user's answer for each | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Hash matched before decrypt | `sha256sum mcp.token.enc` vs the desktop's line | pending: needs the user's yes |
| One line, right file | `grep -c '^PI_SPORE_MCP_TOKEN='` on `profiles/pi-spore/.env`, and `grep -l` across `/opt/data/profiles/*/.env` and `/opt/data/.env` | pending: needs the user's yes |
| `.env` owner and mode unchanged | `ls -ln` before and after | pending: needs the user's yes |
| Gateway restarted, if it needed it | `docker exec <container> hermes gateway status` | pending: needs the user's yes |

## S3 — Tailscale: the grant, and the deny tests

Needs its own yes: it changes the tailnet policy for every device.

Rule and tests in [network-rule.md](network-rule.md).

| Yes | Record |
| --- | --- |
| The user's answer for the policy change | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Saved policy, the two rules for this port | the read-back from the admin console | pending: needs the user's yes |
| From `hermes-docker`: `401` without a token | test 1 | pending: needs the user's yes |
| From another device: no answer | test 2, the exact error line | pending: needs the user's yes |
| No Funnel; no Serve handler on this port | test 3, before and after | pending: needs the user's yes |
| Main server unchanged | test 4 | pending: needs the user's yes |

## S4 — Hermes: the `mcp_servers.pi_spore` entry and its toolset

Needs the user's yes (ADR 0202 §10).

Entry, toolset command, reload, and the three things to watch in [mcp-entry.md](mcp-entry.md).

| Yes | Record |
| --- | --- |
| The user's answer for the `mcp_servers` entry and the toolset change | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Hermes shows the MCP server and **only** the four tools for `pi-spore` | `docker exec <container> hermes mcp` picker, tool list | pending: needs the user's yes |
| `platform_toolsets` after the change, `terminal` and `clarify` intact | `hermes -p pi-spore config get platform_toolsets` | pending: needs the user's yes |
| No `transport`, no `trust`, no literal token in the entry | `hermes -p pi-spore config get mcp_servers.pi_spore` | pending: needs the user's yes |
| A plain-HTTP URL to a non-loopback host was accepted | the connect succeeded; otherwise this card stops here and the user decides | pending: needs the user's yes |

## S5 — Hermes: the skill

Needs the user's yes.

Text and path in [skill.md](skill.md). Check the path first: `docker exec <container> ls /opt/data/profiles/pi-spore`
and what that build lists with `hermes -p pi-spore skills list` — **check before applying**.

| Yes | Record |
| --- | --- |
| The user's answer for adding the skill file | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| The skill is listed for `pi-spore` only | `docker exec <container> hermes -p pi-spore skills list`, and the same listing for another profile shows it absent | pending: needs the user's yes |
| No other profile gained it | the path is under `profiles/pi-spore/` | pending: needs the user's yes |

## S6 — Prove it end to end

Needs the user's yes: it sends real requests to pi-spore, and a Pi chat may work on one.

| # | Check | Expected |
| --- | --- | --- |
| 1 | The MCP server and only the four tools are loaded for `pi-spore` | S4's evidence line |
| 2 | From `hermes-docker`, `list_targets` with the token works | `{"targets":[...]}`; empty means `hermes.inbound.projects` is empty, which is a correct answer and not a pass for this check |
| 3 | From `hermes-docker`, the same call **without** the token | `401 unauthorized` |
| 4 | From another tailnet device, the MCP port does not answer | no HTTP status; S3 test 2 |
| 5 | `tailscale funnel status` shows nothing; `tailscale serve status` shows no handler for this port | S3 test 3 |
| 6 | A `submit_request` arrives as `pending`, and only the user's Accept on Home moves it | `pending` → `accepted` → `running`, at the user's click |
| 7 | `get_request` reads the result later | `completed` with `result`; nothing was pushed into the Hermes session |
| 8 | A request with `hop_count: 1`, sent while working on a pi-spore ask | `403 hop_refused` |
| 9 | The same `request_id` with a different body | `409 request_id_conflict` |

| Yes | Record |
| --- | --- |
| The user's answer for the live test requests, and which workspace was the target | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Checks 1 to 9 | the table above, one line each, with the state each request reached | pending: needs the user's yes |

Checks 6 to 9 are pi-spore's own rules, proved from the Hermes side. Card Hermes 1.5 is the card that proves the
approval and clarify round trips; nothing here claims them.

## Rollback

Each item on its own yes. Rollback is complete when the listener is off, the token is gone from both sides, the entry
and the skill are gone, and the grant is gone.

| What | Command | Evidence |
| --- | --- | --- |
| The listener off | pi-spore Settings: `hermes.mcp.enabled` `false`. `GET /api/hermes/mcp` then answers `{"state":"off"}`, and any live request gets `503 mcp_off` | pending |
| The MCP entry | delete the `pi_spore` block from `/opt/data/profiles/pi-spore/config.yaml` (or the documented unset form — check before applying), then `/reload-mcp` or `docker exec <container> hermes gateway restart`. Read back with `hermes -p pi-spore config get mcp_servers` | pending |
| The toolset | remove `pi_spore` from that profile's API toolset selection, the same surface S4 used; read back with `config get platform_toolsets` | pending |
| The skill | `docker exec <container> rm -rf /opt/data/profiles/pi-spore/skills/pi-spore-remote-teammate` | pending |
| The token on Unraid | `docker exec <container> sed -i '/^PI_SPORE_MCP_TOKEN=/d' /opt/data/profiles/pi-spore/.env`, then `grep -c` for zero, and `ls -ln` to show the mode is unchanged | pending |
| The token on the desktop | `rm -f ~/.pi-spore/hermes/mcp.token`. This also stops the listener from serving anything, even if `hermes.mcp.enabled` is still on: it answers `503 mcp_token_unusable` | pending |
| The transfer files | `rm -rf ~/.pi-spore/hermes/transfer` on the desktop; `rm -f /opt/data/pi-spore-bridge/transfer/receive.*` and any `mcp.token*` on Unraid | pending |
| The grant | delete both ACL lines for this port in the Tailscale console, then confirm S3 test 1 now fails from `hermes-docker` too | pending |

## What this card does not cover

The dashboard on `9119` (card Hermes 0.6), other Hermes profiles, Docker, the approval and clarify round trips (card
Hermes 1.5), the provider setup handoff (cards Hermes 3.x), and A2A. No file in this folder holds a token, a key, or a
real host address: every value in angle brackets is a placeholder.
