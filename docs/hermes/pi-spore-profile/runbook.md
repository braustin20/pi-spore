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
| Hermes version | the tested minor `0.23.x`; the desktop probe saw `0.23.3` | `docker exec <container> hermes --version` |
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
in S2 and S4. `{"state":"failed", ...}` names the cause: no Tailscale address on the desktop, or a token file that is
missing, empty, or too open. Both are S1 failures, not S4 mysteries: in either case the port never opens, so a client
gets "connection refused" and no HTTP answer at all.

| Yes | Record |
| --- | --- |
| Who asked, when, and the user's answer | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Token file modes and size | `ls -lnd ~/.pi-spore/hermes`, `ls -ln ~/.pi-spore/hermes/mcp.token` (0700, 0600, **65 bytes**: 64 hex characters plus a newline) | pending: needs the user's yes |
| Listener state | the listener state from the Settings page or `GET /api/hermes/mcp`, URL only | pending: needs the user's yes |

## S2 — Unraid: the token arrives in the profile's `.env`

Needs the user's yes. Two sub-steps, each with its own yes line, because they run on different machines: the pair and
the write on Unraid, the encrypt-and-send on the desktop.

Commands in [token-delivery.md](token-delivery.md#s2-unraid-a-receiving-key-pair-then-the-token). Nothing is printed
at any point, and the decrypted token is held in a shell variable only: no plaintext token file is created on Unraid,
and the only thing that crosses the wire is the base64 ciphertext and its SHA-256, as chat text.

| Yes | Record |
| --- | --- |
| S2a Unraid key pair, S2b desktop encrypt, S2c Unraid write: the user's answer for each | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Hash matched before decrypt | `sha256sum mcp.token.enc` vs the desktop's line | pending: needs the user's yes |
| No plaintext token file on Unraid | the token went to a shell variable only; `ls` the transfer folder shows `receive.key`, `receive.pub`, `mcp.token.enc` and no `mcp.token*` plaintext file | pending: needs the user's yes |
| One line, right file, no other profile | inside the container shell: `grep -c '^PI_SPORE_MCP_TOKEN='` on `profiles/pi-spore/.env` (1), then `grep -l '^PI_SPORE_MCP_TOKEN=' /opt/data/profiles/*/.env /opt/data/.env` and expect that one path only | pending: needs the user's yes |
| `.env` owner and mode unchanged | `ls -ln` before and after | pending: needs the user's yes |
| Gateway restarted, if it needed it | `docker exec <container> hermes gateway status` | pending: needs the user's yes |

## S3 — Tailscale: the grant, and the deny tests

Needs its own yes: it changes the tailnet policy for every device.

Rule, narrowing, the policy `tests` block, and the live tests in [network-rule.md](network-rule.md). Tailscale policy
is additive: one narrow grant, plus the removal or narrowing of every broad rule that already matches this port, plus a
`tests` entry per other device. There is no `deny` or `reject` rule to lean on.

| Yes | Record |
| --- | --- |
| The user's answer for the policy change | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Policy before, so the narrowing can be reverted | the admin console copy | pending: needs the user's yes |
| Every broad rule that matched this port is narrowed | the list of rules changed, and how | pending: needs the user's yes |
| The one narrow grant, and the `tests` block | the saved policy text for this port, with one deny test per other device | pending: needs the user's yes |
| The policy `tests` pass on save | the admin console's test result | pending: needs the user's yes |
| From `hermes-docker`: `401` without a token | test 1 | pending: needs the user's yes |
| From each other **node**: no answer, run right after test 1 | test 2, the exact error line and the device that ran it | pending: needs the user's yes |
| No Funnel; no Serve handler on this port | test 3, before and after | pending: needs the user's yes |
| Main server unchanged | test 4 | pending: needs the user's yes |

## S4 — Hermes: the `mcp_servers.pi_spore` entry and its toolset

Needs the user's yes (ADR 0202 §10).

Entry, reload, and the three things to watch in [mcp-entry.md](mcp-entry.md). The toolset half has **no verified
enabling command**: `hermes tools enable pi_spore --platform <p>` is rejected by the v0.23.3 CLI, so read the current
state, decide from it whether any change is needed at all, and let step S6's tool list be the proof. See
[mcp-entry.md](mcp-entry.md#allow-the-four-tools-for-this-profiles-api-sessions).

| Yes | Record |
| --- | --- |
| The user's answer for the `mcp_servers` entry and the toolset change | pending: needs the user's yes |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| The **saved** entry: `${env:PI_SPORE_MCP_TOKEN}` as a reference, the four `tools.include` names, and no `transport`, `trust`, or literal value | read `/opt/data/profiles/pi-spore/config.yaml`, with the header masked — the commands in [mcp-entry.md](mcp-entry.md#reload-and-confirm-the-load). Not `hermes config get`: it expands `${env:…}`, so it cannot show what was saved | pending: needs the user's yes |
| The API platform name, as the CLI reported it | `hermes -p pi-spore tools list --platform api_server` | pending: needs the user's yes |
| The toolset decision: no change, or the `platform_toolsets` edit with `terminal`, `clarify`, `pi_spore` | the same read-back, plus the saved `platform_toolsets` text from the file | pending: needs the user's yes |
| **The four tools are loaded for `pi-spore` and no other `mcp__*` tool is** | `/tools list` in a `pi-spore` session, or the tool list of that session; never a bare `hermes mcp`, which reads the default profile | pending: needs the user's yes |
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
| 1 | The four tools are loaded for a `pi-spore` session, and no other `mcp__*` tool | S4's evidence line |
| 2 | From `hermes-docker`, `list_targets` with the token works | `{"targets":[...]}`; empty means `hermes.inbound.projects` is empty, which is a correct answer and not a pass for this check |
| 3 | From `hermes-docker`, the same call **without** the token | `401 unauthorized` — a transport answer, before any tool runs |
| 4 | From another tailnet node, the MCP port does not answer | no HTTP status; S3 test 2, run right after check 3 |
| 5 | `tailscale funnel status` shows nothing; `tailscale serve status` shows no handler for this port | S3 test 3 |
| 6 | A `submit_request` arrives as `pending`, and only the user's Accept on Home moves it | `pending` → `accepted` → `running`, at the user's click |
| 7 | `get_request` reads the result later | `completed` with `result`; nothing was pushed into the Hermes session |
| 8 | A **new** `request_id` with `hop_count: 1`, sent while working on a pi-spore ask | the tool call fails: HTTP 200, `isError: true`, text naming `hop_count above 0`. Not `403` — a tool error never carries an HTTP code or the internal `hop_refused` name. A used `request_id` is answered from storage first, so the hop check needs a fresh id |
| 9 | **Check 6's stored** `request_id`, sent again with `hop_count: 0`, the same `target` and `kind`, and one changed body field such as `title` | the tool call fails: `isError: true`, text saying the request `was already sent with a different body`. Not `409`, and no `request_id_conflict` name on the wire. Not check 8's id either: that request was refused before it was stored, so reusing it only brings the hop error back, and with `hop_count: 0` it would create a new pending request instead of a conflict |

Checks 8 and 9 are the two cases where pi-spore refuses inside a tool call: the listener answers `200 OK` with a JSON-RPC
result whose `isError` is `true` and whose one text item is the message, so the evidence line quotes that text. The
named codes `hop_refused` and `request_id_conflict` are pi-spore's internal error names; they appear in pi-spore's log
and its HTTP API, not in the MCP answer. Keep them apart from check 3, where no tool runs at all and the answer is a
real `401`.

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
and the skill are gone, and the grant is gone. Take the last policy evidence **before** restoring the broad Tailscale
allowances, because those allowances restore reach for every node: see the grant row.

| What | Command | Evidence |
| --- | --- | --- |
| The listener off, first | pi-spore Settings: `hermes.mcp.enabled` `false`. `GET /api/hermes/mcp` then answers `{"state":"off"}`, and the settings check closes the port, so a client gets "connection refused". `503 mcp_off` is only the answer in the moments before that check runs | pending: "connection refused" from `hermes-docker`, taken while the grant is still in place |
| The MCP entry | delete the `pi_spore` block from `/opt/data/profiles/pi-spore/config.yaml` (or the documented unset form — check before applying), then `/reload-mcp` or `docker exec <container> hermes gateway restart`. Read the **file** back: `grep -c "^  pi_spore:"` and `grep -c "PI_SPORE_MCP_TOKEN"` on `/opt/data/profiles/pi-spore/config.yaml`, both `0` | pending |
| The toolset | only if S4 changed it: put that profile's API toolset selection back to what its read-back showed before, the same surface S4 used; confirm with `hermes -p pi-spore tools list --platform api_server` | pending |
| The skill | `docker exec <container> rm -rf /opt/data/profiles/pi-spore/skills/pi-spore-remote-teammate` | pending |
| The token on Unraid | inside the container shell: `sed -i '/^PI_SPORE_MCP_TOKEN=/d' /opt/data/profiles/pi-spore/.env`, then `grep -c` for zero, and `ls -ln` to show the mode is unchanged | pending |
| The token on the desktop, on its own | `rm -f ~/.pi-spore/hermes/mcp.token`. With the listener still enabled the port **stays open**: the token is read per request, so every request answers `503 mcp_token_unusable` and nothing is served. "Connection refused" is the evidence for the listener-off row, or for a start that never opened (no Tailscale address, or no token file when the check first ran) — not for this row | pending |
| The transfer files | on the desktop, `rm -f ~/.pi-spore/hermes/transfer/unraid-receive.pub ~/.pi-spore/hermes/transfer/mcp.token.enc` — **not** the whole folder, which holds the card Hermes 0.4 pair until card Hermes 0.5 retires it; on Unraid, `rm -f /opt/data/pi-spore-bridge/transfer/receive.key /opt/data/pi-spore-bridge/transfer/receive.pub /opt/data/pi-spore-bridge/transfer/mcp.token.enc` | pending |
| The grant, last | with the listener already off and test 1 already confirmed failing from `hermes-docker`: delete the grant and the `tests` entries for this port, restore each narrowed rule, save | pending: a diff of the saved policy against the "before" copy. **After** this, the port answers again from every node a broad rule allows, so no later "denied" result is policy evidence — it only shows the listener is off |

## What this card does not cover

The dashboard on `9119` (card Hermes 0.6), other Hermes profiles, Docker, the approval and clarify round trips (card
Hermes 1.5), the provider setup handoff (cards Hermes 3.x), and A2A. No file in this folder holds a token, a key, or a
real host address: every value in angle brackets is a placeholder.
