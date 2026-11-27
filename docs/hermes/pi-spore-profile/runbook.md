# Runbook: give the Hermes profile `pi-spore` its skill, its MCP entry, and its rule

Card Hermes 1.4, [ADR 0202](../../decisions/0202-hermes-remote-teammate.md) §8, §9, §10, §12. The code side is merged:
the MCP listener and requests from Hermes (card Hermes 1.3, `modules/hermes/src/mcp/listener.ts`,
`modules/hermes/src/inbound.ts`).

**Status, 2026-11-26: applied (card Hermes 1.4b).** S1, S2, S4, S5 and S6 are done, each with the user's yes and an
evidence line. S3 was skipped by the user, for good: the tailnet policy is unchanged, and a desktop firewalld rule
that admits only `hermes-docker` on the MCP port takes its place (see S4). This build keeps the profile under
`/home/hermes/.hermes/profiles/pi-spore/`, not `/opt/data/profiles/pi-spore/`. The evidence lines and the rollback
table use the real path (rollback fixed by card Hermes 1.5); the step commands still show the old one. This runbook
is the record.

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
| Who asked, when, and the user's answer | Asked by the card Hermes 1.4b chat on 2026-11-26 (Home question `01M8DD2NDKNYANDNSCBRA6AB5H`). The user answered **Yes**. `hermes.inbound.projects`: Pi Spore, Paint Crafter, Super Space Scavengers (all three projects) |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Token file modes and size | `ls -lnd ~/.pi-spore/hermes`, `ls -ln ~/.pi-spore/hermes/mcp.token` (0700, 0600, **65 bytes**: 64 hex characters plus a newline) | 2026-11-26: `drwx------ 1000 1000 ~/.pi-spore/hermes`; `-rw------- 1000 1000 65 ~/.pi-spore/hermes/mcp.token`. Made with `openssl rand -hex 32`; never printed |
| Settings | global `settings.json`, the `hermes` table only (backup kept as `settings.json.bak-hermes-1-4b`) | `hermes.mcp.enabled: true`; `hermes.inbound.projects`: the three project ids; every other key unchanged (diff empty) |
| Listener state | the listener state from the Settings page or `GET /api/hermes/mcp`, URL only | `{"state":"listening","url":"http://<desktop-tailscale-ip>:7430/mcp"}`; `ss -ltn` shows `<desktop-tailscale-ip>:7430` and the main server still on `127.0.0.1:7420` only. A local POST with no token answers `401` |

## S2 — Unraid: the token arrives in the profile's `.env`

Needs the user's yes. Two sub-steps, each with its own yes line, because they run on different machines: the pair and
the write on Unraid, the encrypt-and-send on the desktop.

Commands in [token-delivery.md](token-delivery.md#s2-unraid-a-receiving-key-pair-then-the-token). Nothing is printed
at any point, and the decrypted token is held in a shell variable only: no plaintext token file is created on Unraid,
and the only thing that crosses the wire is the base64 ciphertext and its SHA-256, as chat text.

| Yes | Record |
| --- | --- |
| S2a Unraid key pair, S2b desktop encrypt, S2c Unraid write: the user's answer for each | S2a and S2b: asked on 2026-11-26 (Home question `01M8DD5P5ND7VK4A2HDSE4KCQ5`); the user ran S2a through Homelab Maintainer and sent its answer back to go on to S2b. S2c: asked on 2026-11-26 (Home question `01M8DDDPNEN8NQDYXVG7NGEAYV`); the user ran it through Homelab Maintainer |

S2a findings, 2026-11-26: Hermes `v0.23.3`. `pi-spore` approvals read back `mode: manual`, `unattended_mode: deny`, `cron_mode: deny`, `deny: []`. Homelab Maintainer ran the commands inside the container itself (no Docker socket there). The pair is `receive.key` (`0600`, 3268 bytes) and `receive.pub` (800 bytes) in `/opt/data/pi-spore-bridge/transfer`; neither existed before. **Path correction:** this build keeps the profile at `/home/hermes/.hermes/profiles/pi-spore/`, not `/opt/data/profiles/pi-spore/`. `/opt/data/profiles/pi-spore/.env` does not exist; the profile's `.env` is `/home/hermes/.hermes/profiles/pi-spore/.env` (`0600`, owner `99:100`). S2c and later steps use that path.

S2b, 2026-11-26: the public key decoded to a 4096-bit PEM key, different from the card Hermes 0.4 pair. `~/.pi-spore/hermes/transfer/mcp.token.enc` is 512 bytes, SHA-256 `b8abc1b0…eba6fd`. Only its base64 and that hash left the desktop.

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Hash matched before decrypt | `sha256sum mcp.token.enc` vs the desktop's line | 2026-11-26: matched, `b8abc1b0…eba6fd`; the block printed `written` |
| No plaintext token file on Unraid | the token went to a shell variable only; `ls` the transfer folder shows `receive.key`, `receive.pub`, `mcp.token.enc` and no `mcp.token*` plaintext file | the transfer folder holds `mcp.token.enc` (512), `receive.key` (3268), `receive.pub` (800), all `0600`, and nothing else |
| One line, right file, no other profile | inside the container shell: `grep -c '^PI_SPORE_MCP_TOKEN='` on `profiles/pi-spore/.env` (1), then `grep -l '^PI_SPORE_MCP_TOKEN='` over every profile `.env` and the shared `.env` and expect that one path only | count `0` before, `1` after; stored length `64`. `grep -l` over `/home/hermes/.hermes/profiles/*/.env`, `/home/hermes/.hermes/.env`, `/opt/data/profiles/*/.env`, `/opt/data/.env` lists only `/home/hermes/.hermes/profiles/pi-spore/.env` |
| `.env` owner and mode unchanged | `ls -ln` before and after | `-rw------- 99 100` before and after; 264 bytes to 348 (one 84-byte line added) |
| Gateway restarted, if it needed it | `docker exec <container> hermes gateway status` | not restarted in S2; deferred to S4, which reloads after the entry is added |

## S3 — Tailscale: the grant, and the deny tests

Needs its own yes: it changes the tailnet policy for every device.

**Skipped by the user, for good, on 2026-11-26** (Home question `01M8DEES0Z3RTZ38FZ0V003XAX`, answer "Let's just skip this for good"). The tailnet policy is unchanged: the template's allow-all grant still lets every tailnet device reach `tcp:7430` on the desktop. The listener's own guards (Tailscale-address bind, `Host` check, bearer token) are the only lock. ADR 0202 §10 named the grant as the second lock; [ADR 0203](../../decisions/0203-hermes-mcp-port-locked-by-desktop-firewall.md) replaces it with the desktop firewalld rule added in S4, which admits only `hermes-docker`. S6 check 4 passes on that rule.

Rule, narrowing, the policy `tests` block, and the live tests in [network-rule.md](network-rule.md). Tailscale policy
is additive: one narrow grant, plus the removal or narrowing of every broad rule that already matches this port, plus a
`tests` entry per other device. There is no `deny` or `reject` rule to lean on.

| Yes | Record |
| --- | --- |
| The user's answer for the policy change | Asked on 2026-11-26 (Home question `01M8DE8XAJZBGFFW7YGFRPNVQ5`). The user said yes by pasting the current policy for the edit |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Policy before, so the narrowing can be reverted | the admin console copy | 2026-11-26: the template's allow-all grant `{"src":["*"],"dst":["*"],"ip":["*"]}`. The copy is kept in the workspace artifact `s3/policy-before.md`, not in git |
| Every broad rule that matched this port is narrowed | the list of rules changed, and how | skipped by the user: no rule changed |
| The one narrow grant, and the `tests` block | the saved policy text for this port, with one deny test per other device | skipped by the user: not added |
| The policy `tests` pass on save | the admin console's test result | skipped by the user: nothing saved |
| From `hermes-docker`: `401` without a token | test 1 | see S6 check 3 |
| From each other **node**: no answer, run right after test 1 | test 2, the exact error line and the device that ran it | skipped by the user: with no grant, other nodes are expected to reach the port |
| No Funnel; no Serve handler on this port | test 3, before and after | 2026-11-26, desktop, before S4 and again after it: `funnel status` and `serve status` show only `https://<desktop-tailnet-name> (tailnet only)`, `/ proxy http://127.0.0.1:7420` (ADR 0143). No Funnel, no handler for `7430` |
| Main server unchanged | test 4 | `curl http://127.0.0.1:7420/api/health` answers `200`; `ss -ltn` shows `7420` on `127.0.0.1` only |

## S4 — Hermes: the `mcp_servers.pi_spore` entry and its toolset

Needs the user's yes (ADR 0202 §10).

Entry, reload, and the three things to watch in [mcp-entry.md](mcp-entry.md). The toolset half has **no verified
enabling command**: `hermes tools enable pi_spore --platform <p>` is rejected by the v0.23.3 CLI, so read the current
state, decide from it whether any change is needed at all, and let step S6's tool list be the proof. See
[mcp-entry.md](mcp-entry.md#allow-the-four-tools-for-this-profiles-api-sessions).

| Yes | Record |
| --- | --- |
| The user's answer for the `mcp_servers` entry and the toolset change | Asked on 2026-11-26 (Home question `01M8DER25PMX6HV0R8RW7AK0GX`); the user said yes by running the read-only part 1 through Homelab Maintainer. The write (part 2): asked on 2026-11-26 (Home question `01M8DFAH4NRHE6CEYDPTWH5216`); the user ran it through Homelab Maintainer |

S4 part 1 read-back, 2026-11-26. The profile file is `/home/hermes/.hermes/profiles/pi-spore/config.yaml` (362 bytes). Top-level keys: `approvals`, `command_allowlist: []`, `model`, `platform_toolsets`, `terminal`, `fallback_providers`. No `mcp_servers` key and no `PI_SPORE_MCP_TOKEN` in it. `platform_toolsets.api_server` is `[terminal, clarify]`, and `tools list --platform api_server` shows only those two enabled (plugin `a2a` disabled). `skills list` shows only the builtin `hermes-agent`. The gateway runs as the default profile's multiplexer. Homelab Maintainer is itself a Hermes profile in the same container.

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| The **saved** entry: `${env:PI_SPORE_MCP_TOKEN}` as a reference, the four `tools.include` names, and no `transport`, `trust`, or literal value | read `/opt/data/profiles/pi-spore/config.yaml`, with the header masked — the commands in [mcp-entry.md](mcp-entry.md#reload-and-confirm-the-load). Not `hermes config get`: it expands `${env:…}`, so it cannot show what was saved | 2026-11-26: written with `hermes -p pi-spore config set mcp_servers.pi_spore` (not a heredoc), after a backup at `profiles/pi-spore/backups/config.yaml.before-hermes-1-4b`. The file is `/home/hermes/.hermes/profiles/pi-spore/config.yaml`, 362 to 657 bytes, mode `0644` unchanged. The diff against the backup adds only `mcp_servers.pi_spore`: `url: http://<desktop-tailscale-ip>:7430/mcp`, `headers.Authorization: <value not shown>`, `tools.include` the four names, `resources: false`, `prompts: false`. No `transport`, no `trust`. `grep -F 'Bearer ${env:PI_SPORE_MCP_TOKEN}'` matches (the header is a reference); `PI_SPORE_MCP_TOKEN` count `1`. `approvals.mode` still `manual` |
| The API platform name, as the CLI reported it | `hermes -p pi-spore tools list --platform api_server` | `api_server`. After a 90-second wait, with no restart, it lists `MCP servers: pi_spore [include only: list_targets, submit_request, get_request, cancel_request]`. `hermes -p pi-spore mcp list` shows `pi_spore http://<desktop-tailscale-ip>:7430/mcp 4 selected ✓ enabled` |
| The toolset decision: no change, or the `platform_toolsets` edit with `terminal`, `clarify`, `pi_spore` | the same read-back, plus the saved `platform_toolsets` text from the file | **No change.** `platform_toolsets.api_server` stays `[terminal, clarify]`. It names no MCP server, so v0.23.3 adds every enabled server (`hermes_cli/tools_config.py` `_merge_mcp_servers`); the resolver gives `['clarify', 'pi_spore', 'terminal']`, and `pi_spore` is the only MCP server on this profile. If the profile ever gains a second MCP server, the list must name `pi_spore` |
| **The four tools are loaded for `pi-spore` and no other `mcp__*` tool is** | `/tools list` in a `pi-spore` session, or the tool list of that session; never a bare `hermes mcp`, which reads the default profile | **Pass, 2026-11-26**, on the third check: a fresh `pi-spore` API session through `ask_hermes` (handoff `01M8DJBBPRTPT9N9QH9BC261NA`) has exactly `mcp__pi_spore__cancel_request`, `mcp__pi_spore__get_request`, `mcp__pi_spore__list_targets`, `mcp__pi_spore__submit_request`, and no other `mcp__*` tool; tool search for `pi_spore` finds the same four. The gateway reconnected the parked server on its own retry, with no restart. Earlier: two `pi-spore` API sessions opened through pi-spore's `ask_hermes` (handoffs `01M8DFVKD0WAMRWRPBA5YMFJT4`, `01M8DFXS4ZMW51M1W6YQDER1AR`): no `mcp__*` tool. The session's tools are `clarify`, `terminal`, `hermes_tool_search`, `tool_describe`, `tool_call`, `multi_tool_use.parallel`; `hermes_tool_search` for `pi_spore` and for `mcp` returns nothing. No connection to `:7430` was seen on the desktop. Diagnosis, 2026-11-26: the gateway reconciled the entry (`MCP servers reconciled with config (pi-spore): added=['pi_spore']`) and the platform resolver gives `api_server` `['clarify', 'pi_spore', 'terminal']`, so the toolset list is not the cause. Cause 1: the connect fails, `[Errno 113] Connect call failed ('<desktop-tailscale-ip>', 7430)`, and the server is parked after 3 attempts; `curl` from the container fails after 0 ms and `hermes -p pi-spore mcp test pi_spore` fails. The desktop's firewalld zone `tailscale` (on `tailscale0`) does not allow `7430/tcp`. Fix 1, with the user's yes (Home question `01M8DGJNXC4DKXEX52KTZMDNRX`, option "Allow only hermes-docker on 7430"): the user added one firewalld rich rule to the zone `tailscale`, `rule family="ipv4" source address="<hermes-docker-tailscale-ip>/32" port port="7430" protocol="tcp" accept`, and reloaded (backup `/etc/firewalld/zones/tailscale.xml.bak-hermes-1-4b`). Only `hermes-docker` passes the desktop firewall on this port; with S3 skipped, this is the source lock. `ufw` is also active (default deny incoming) and has no rule for `7430`. Cause 2, the gateway's `Config ref '${env:PI_SPORE_MCP_TOKEN}': PI_SPORE_MCP_TOKEN is not set … keeping the literal placeholder` warning: harmless for MCP. Homelab Maintainer read the v0.23.3 source: the generic config expansion (`hermes_cli/config.py` `_env_expand_match`) runs outside the profile's secret scope and logs it, but the MCP connect path (`tools/mcp_tool_discovery.py`) installs the owning profile's secret scope (`build_profile_secret_scope`, from `profiles/pi-spore/.env`), interpolates again, and refuses to connect with `missing_credentials` if a `${…}` is still left (`mcp_tool_config.py` `_require_rendered_remote`). A literal placeholder is never sent. Retest after fix 1 (Home question `01M8DH3K3Q1J3JN8J1A728GVQ4`): `curl` from the container with no token answers `401`; `hermes -p pi-spore mcp test pi_spore` answers `✓ Connected (1556ms)`, `✓ Tools discovered: 4` (`list_targets`, `submit_request`, `get_request`, `cancel_request`). The running gateway still had `pi_spore` parked: a profile-scoped `reload.mcp` (`gateway/session_ancillary.py`) was refused, `mcp_servers_unavailable … did not connect: pi_spore` |
| A plain-HTTP URL to a non-loopback host was accepted | the connect succeeded; otherwise this card stops here and the user decides | Yes: `http://<desktop-tailscale-ip>:7430/mcp` connects (`mcp test` and the live session above). No `skip_preflight` was needed |

## S5 — Hermes: the skill

Needs the user's yes.

Text and path in [skill.md](skill.md). Check the path first: `docker exec <container> ls /opt/data/profiles/pi-spore`
and what that build lists with `hermes -p pi-spore skills list` — **check before applying**.

| Yes | Record |
| --- | --- |
| The user's answer for adding the skill file | Asked on 2026-11-26 (Home question `01M8DFXG1H0V3V2M20TTGPTVAP`); the user ran it through Homelab Maintainer |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| The skill is listed for `pi-spore` only | `docker exec <container> hermes -p pi-spore skills list`, and the same listing for another profile shows it absent | 2026-11-26: written to `/home/hermes/.hermes/profiles/pi-spore/skills/pi-spore-remote-teammate/SKILL.md` (4624 bytes, SHA-256 `69749680…8f87024`, the text in [skill.md](skill.md)). `hermes -p pi-spore skills list` shows it `local`, `enabled`, next to the builtin `hermes-agent`. The `homelab-maintainer` and default listings do not show it |
| No other profile gained it | the path is under `profiles/pi-spore/` | the global `skills/pi-spore-remote-teammate` does not exist; the only match under `profiles/*/skills/` is `pi-spore`'s. Note: the `skills` toolset is off for `api_server`, so this proves the skill is installed, not that an API session loads it |

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
| The user's answer for the live test requests, and which workspace was the target | Asked on 2026-11-26 (Home question `01M8DJDRV7K94JMVWNQRZCDFNF`). The user answered **Yes**. Target: the card Hermes 1.4b workspace (`01M8DD1DC8A4FBQSZ7MBXY9NNQ`, project Pi Spore). The requests were sent from a new chat on pi-spore's Hermes page (`/hermes`), so `hop_count: 0` was correct for check 6 |

| Evidence | How | Result (redacted) |
| --- | --- | --- |
| Check 1 | S4's evidence line | pass: the four `mcp__pi_spore__*` tools, no other `mcp__*` tool |
| Check 2 | `list_targets` from a `pi-spore` session | pass: the session called `mcp__pi_spore__list_targets`, picked the target `01M8DD1DC8A4FBQSZ7MBXY9NNQ` from it, and submitted to it (check 6) |
| Check 3 | `curl` from the container, no token | pass: `401` (the S4 retest) |
| Check 4 | another tailnet node, right after check 3 | pass, with a caveat: from the user's iPhone with Wi-Fi off (Tailscale only), the URL did not load. The lock is the desktop's firewalld rule (only `hermes-docker`), not a Tailscale grant: S3 was skipped |
| Check 5 | `tailscale funnel status`, `tailscale serve status` | pass: only the `7420` handler from ADR 0143; no Funnel, nothing for `7430`. Main server: `127.0.0.1:7420` only, health `200` |
| Check 6 | `submit_request` `s6-check6-20261126`, `hop_count: 0` | pass: stored as handoff `01M8DJMWZAJ0WY6W5K8F2QS2PH`; the request reached the workspace chat only after the user's Accept on Home; the chat answered `ok` with `reply_hermes` |
| Check 7 | `get_request` later | pass: `{"request_id":"s6-check6-20261126","state":"completed","target":"01M8DD1DC8A4FBQSZ7MBXY9NNQ","title":"S6 check 6","result":"ok"}`; nothing was pushed into the Hermes session |
| Check 8 | a new `request_id` with `hop_count: 1` | pass: the first try's answer was cut off on the Hermes page, so it was sent again from inside a pi-spore ask (handoff `01M8DJY2CSNZFXSZ9TZQXWYBA6`, new id `s6-check8b-20261126`). The tool call failed, marked as an error: `This request came from a pi-spore ask (hop_count above 0); pi-spore refuses it, so no loop forms`. No HTTP code, no internal name. pi-spore stored no row for either check 8 id; the only inbound row is check 6's |
| Check 9 | check 6's id, `hop_count: 0`, title changed | pass: the tool call failed with `Request s6-check6-20261126 was already sent with a different body; a new request needs a new request_id`; no HTTP code, no internal error name; no second row stored |

Checks 6 to 9 are pi-spore's own rules, proved from the Hermes side. Card Hermes 1.5 is the card that proves the
approval and clarify round trips; nothing here claims them.

## Rollback

Each item on its own yes. Rollback is complete when the listener is off, the token is gone from both sides, the entry
and the skill are gone, and the grant is gone. Take the last policy evidence **before** restoring the broad Tailscale
allowances, because those allowances restore reach for every node: see the grant row.

| What | Command | Evidence |
| --- | --- | --- |
| The listener off, first | pi-spore Settings: `hermes.mcp.enabled` `false`. `GET /api/hermes/mcp` then answers `{"state":"off"}`, and the settings check closes the port, so a client gets "connection refused". `503 mcp_off` is only the answer in the moments before that check runs | pending: "connection refused" from `hermes-docker`, taken while the grant is still in place |
| The MCP entry | delete the `pi_spore` block from `/home/hermes/.hermes/profiles/pi-spore/config.yaml` (or the documented unset form — check before applying), then `/reload-mcp` or `docker exec <container> hermes gateway restart`. Read the **file** back: `grep -c "^  pi_spore:"` and `grep -c "PI_SPORE_MCP_TOKEN"` on `/home/hermes/.hermes/profiles/pi-spore/config.yaml`, both `0` | pending |
| The toolset | only if S4 changed it: put that profile's API toolset selection back to what its read-back showed before, the same surface S4 used; confirm with `hermes -p pi-spore tools list --platform api_server` | pending |
| The skill | `docker exec <container> rm -rf /home/hermes/.hermes/profiles/pi-spore/skills/pi-spore-remote-teammate` | pending |
| The token on Unraid | inside the container shell: `sed -i '/^PI_SPORE_MCP_TOKEN=/d' /home/hermes/.hermes/profiles/pi-spore/.env`, then `grep -c` for zero, and `ls -ln` to show the mode is unchanged | pending |
| The token on the desktop, on its own | `rm -f ~/.pi-spore/hermes/mcp.token`. With the listener still enabled the port **stays open**: the token is read per request, so every request answers `503 mcp_token_unusable` and nothing is served. "Connection refused" is the evidence for the listener-off row, or for a start that never opened (no Tailscale address, or no token file when the check first ran) — not for this row | pending |
| The transfer files | on the desktop, `rm -f ~/.pi-spore/hermes/transfer/unraid-receive.pub ~/.pi-spore/hermes/transfer/mcp.token.enc` — **not** the whole folder, which holds the card Hermes 0.4 pair until card Hermes 0.5 retires it; on Unraid, `rm -f /opt/data/pi-spore-bridge/transfer/receive.key /opt/data/pi-spore-bridge/transfer/receive.pub /opt/data/pi-spore-bridge/transfer/mcp.token.enc` | pending |
| The desktop firewall rule | `sudo firewall-cmd --permanent --zone=tailscale --remove-rich-rule='rule family="ipv4" source address="<hermes-docker-tailscale-ip>/32" port port="7430" protocol="tcp" accept'`, then `sudo firewall-cmd --reload`. Added in S4 because S3 was skipped | pending |
| The grant, last | not applied: S3 was skipped. Otherwise, with the listener already off and test 1 already confirmed failing from `hermes-docker`: delete the grant and the `tests` entries for this port, restore each narrowed rule, save | pending: a diff of the saved policy against the "before" copy. **After** this, the port answers again from every node a broad rule allows, so no later "denied" result is policy evidence — it only shows the listener is off |

## What this card does not cover

The dashboard on `9119` (card Hermes 0.6), other Hermes profiles, Docker, the approval and clarify round trips (card
Hermes 1.5), the provider setup handoff (cards Hermes 3.x), and A2A. No file in this folder holds a token, a key, or a
real host address: every value in angle brackets is a placeholder.
