# Hermes live acceptance

Live checks of the Hermes integration (ADR 0202) against the real Unraid Hermes profile `pi-spore`. Fakes do not
count. Phase 1 is handoffs in both directions (card Hermes 1.5). Phase 2 is the Hermes chat page (card Hermes 2.3).

## Phase 1: handoffs in both directions (card Hermes 1.5)

Run on 2026-11-27 (UTC), except line 1 and line 15 (04:30). Times below are UTC.

- Hermes: `0.23.3` (`GET /p/pi-spore/health`), at `http://hermes-docker:8642`, profile `pi-spore`. Model
  `gpt-6.1-sol`; line 1 reports provider `openai-codex`. The run API leaves the provider blank.
- pi-spore: commit `b88f904` (main), the user's server on port 7420 (Hermes module built 2026-11-26 16:55 -08:00,
  after the last code change). `hermes.approvalSeconds` 300, Hermes `approvals.timeout` default. No config changed.
- Pi to Hermes: `ask_hermes` from this card's workspace chat (workspace `01M8DM6XPVHCZMSAQHEJ17R53M`, agent
  `01M8DM722P7WB7KPP53TT6CK57`). The user answered every approval and question on Home or the Hermes page it links
  to. The agent sent only the API answers named below (line 4 late answer, line 5 probes).
- Hermes to Pi: a chat session on the Hermes page (`pi-spore-chat-01M8F088ZF7ZY77C7DYFWZM2T5`), so `hop_count: 0`.
  The target was this workspace, so this chat received the requests.
- Facts come from `GET /api/hermes/handoffs`, `GET /api/attention/inbox` (the Home items), and the Hermes session
  records (`GET /p/pi-spore/api/sessions/<id>/messages`). Screenshots: `p1-*.png` in
  [`hermes-acceptance/`](hermes-acceptance/), taken with `node scripts/screenshot.mjs` against the user's server.
  No key, token, or header is in this doc.
- Delivery: every handoff result arrived in the chat as exactly one message. The messages queue while the chat
  works and arrive after its turn ends, so some came late. No result came twice.

| # | Check | Result |
| --- | --- | --- |
| 1 | Harmless question arrives once | Pass |
| 2 | `once` allows only the intended step | Pass |
| 3 | `deny` blocks through the UI | Pass |
| 4 | Timeout fails closed; a late answer posts nothing | Pass. The Home item closes at expiry; it shows no "expired" label (as in Phase 2 line 5) |
| 5 | Double answer, stale answer, wrong run, wrong generation | Pass |
| 6 | Clarify round trip | Pass on the third try. **Failed twice**: Hermes waits 1 minute, Home says 300 s. Bug card 01M8EZZQZE3TN1DW39P2Z0N30W |
| 7 | Cancel | Pass |
| 8 | Hermes gateway restart mid-run | Pass |
| 9 | pi-spore restart mid-run | Pass, on the user's server |
| 10 | `submit_request`, Accept, reply, `get_request` | Pass |
| 11 | Decline, `get_request` shows `cancelled` | Pass |
| 12 | Same `request_id` twice gives one approval | Pass |
| 13 | Loop try from a chat working on a Hermes request | Pass |
| 14 | Target outside `hermes.inbound.projects` | Pass, with an unknown id (all three projects are listed) |
| 15 | Key isolation and the session list | Pass |
| 16 | `hermes.enabled` off: no traffic, MCP port closed | Pass |
| 17 | Rollback on paper | Pass, with one doc fix: the runbook's rollback commands used an old path (fixed here) |

### 1. Question

- 04:30:36. Handoff `01M8DMA07DK1X1CSBSKMHSBDZ8`, run `run_c536b4b7a30049248a6e92f20d9a26bd`, session
  `pi-spore-01M8DMA07DK1X1CSBSKMHSBDZ8`. `completed` at 04:30:42. No tool call.
- Reply: "Hermes version: unknown; provider: openai-codex; model: gpt-6.1-sol." One message in the chat.

### 2. Allow once

The command was a Python heredoc that writes one file in `/opt/data/pi-spore-bridge`; Hermes flags it as "script
execution via heredoc".

- 17:06:25. Handoff `01M8EZHY22J7MWKBW8PP0CQ389`, run `run_42806d81b9314bcdbbd81cee855fea99`. Home item
  `control:01M8EZHY22J7MWKBW8PP0CQ389:c86cb7afccd744a8ad9cd12e20e6715b` at 17:06:33.
- The user picked "Allow once" by 17:06:50. Reply `DONE` at 17:06:52.
- Session: one tool call, `terminal`, exit 0, "Command required approval (script execution via heredoc) and was
  approved by the user." No other tool.
- File (read back by a later read-only handoff, `01M8F04RW4ZT1QWFTJ9BZ6RC1S`): `approval-1.txt`, 29 bytes, written
  17:06:49.886, text `PI_SPORE_ACCEPTANCE_1_5_ONCE`.

### 3. Deny

- 17:07:06. Handoff `01M8EZKA8BWJ3616JNZS46KRR0`. The user picked "Deny". Reply `BLOCKED`.
- Session: one `terminal` call, exit -1, "BLOCKED: Command denied by user. The user has NOT consented to this
  action." No other tool. No `denied-1.txt` in the folder.

### 4. Timeout

- 17:07:38. Handoff `01M8EZM9Z4KFJGGR0FBPVC4KJM`, control `180075b2feb8409b8f662cb9ce651e74` from 17:07:47.773,
  expires 17:12:47.773 (300 s). Not answered.
- 17:12:49.858. `completed`, reply `BLOCKED`. Tool result: "BLOCKED: Command timed out without user response."
  Control `expired`. No Home item at 17:13:10. No `expired-1.txt` in the folder.
- 17:13:17. Late answer from the agent, `POST /api/hermes/handoffs/01M8EZM9Z4KFJGGR0FBPVC4KJM/controls/180075b2...`
  `{"choice":"once"}`: `409 control_expired`, "This Hermes request is expired; nothing was sent". The Hermes
  session did not change.

### 5. Double, stale, wrong run, wrong generation

- User double-click: handoff `01M8F02WZCHAGDX1HRTAE0H393`, run `run_2552e3304fff46e6ad37cea594232439`. One approval
  reached Hermes: one `terminal` call, approved; `approval-5.txt` (31 bytes, 17:15:55.390,
  `PI_SPORE_ACCEPTANCE_1_5_DOUBLE`). Reply `DONE`. The browser shows no second post; the server-side check is below.
- Two answers at the same moment (agent, two parallel `POST .../controls/c5a4055725b24b3e80e301c1e762277d`
  `{"choice":"deny"}`, 17:16:25.7, handoff `01M8F041Y3P705MJG2BAH9JVYX`): one answered; the other got `409
  control_expired`, "This Hermes request is answering; nothing was sent". Hermes saw one deny. Reply `BLOCKED`.
- Stale: 17:13:17, an answer to line 2's answered control: `409 control_expired`, "This Hermes request is answered;
  nothing was sent".
- The build has no test route for a wrong run or generation, so the agent probed Hermes directly with the user's yes.
  Handoff `01M8F05GT1D772WN3TPRYKA98X`, run `run_acdb58ba156e43aab1a7c3106af1c1a9`, pending approval
  `eef4c8df...` at generation 1. 17:17:16.748, `POST /v1/runs/<run>/approval` with generation 7 and `deny`:
  `409 stale_generation`. Afterwards the run was still `waiting_for_approval` with the same prompt, and pi-spore's
  control still `open`. A real deny through pi-spore then closed it. No `denied-5c.txt` in the folder.
- Wrong run: `POST /v1/runs/run_000.../approval`: `404 run_not_found`.

### 6. Clarify

- First try, 17:07:55, handoff `01M8EZMG5DA3KPD8GBVC3P54VK`, control `d898f79984`. pi-spore set it to expire at
  17:12:55; the Home item said "287 s left". Hermes ended the clarify at about 17:09:27: `"outcome": "timed_out",
  "notice": "[user did not respond within 1m]"`. Reply `COLOR=null`. The second try
  (`01M8EZR6AMAF7SQ6CCPJ0A7HJA`) ended the same way, `COLOR=unanswered`.
- Cause: pi-spore gives a clarify control the approval timeout (300 s). Hermes 0.23.3 waits 1 minute for a clarify.
  Phase 2 line 6 passed only because the answer came in under 1 s. Bug card 01M8EZZQZE3TN1DW39P2Z0N30W.
- Third try, handoff `01M8F01YC5GKHYABJNMP8YEV8D`, told to answer within a minute: control at 17:15:16, answered
  "blue" on Home by 17:15:24. Tool result `"status": "answered", "user_response": "blue"`, `"outcome":
  "submitted"`. Reply `COLOR=blue`.

### 7. Cancel

- Handoff `01M8F060GF6SVTPYACCD72DDBX`, run `run_f3e88ec5c1fc4909a267942e9664360a`: `sleep 5`, then `sleep 120`.
- 17:17:38, step 2 running. `cancel_hermes_ask` answered "Asked Hermes to stop handoff ... Steps it completed are
  not undone." At 17:17:47.494 the handoff was `cancelled`; the Hermes run status `cancelled`; step 2's result
  `[Command interrupted]`, exit 130. Chat message: "It was cancelled. Steps Hermes completed are not undone."

### 8. Hermes gateway restart

- 17:20:54. Handoff `01M8F0CEQPEY2RDVPF5V2ZX3JQ`, run `run_972e1a547ab3414fad294833c32d938f`, ten `sleep 55`.
- About 17:23 to 17:24, the user had Homelab Maintainer run `docker exec <container> hermes gateway restart`.
- 17:24:29. pi-spore status `ready`, handoff still `running`; the Hermes run status `unknown`.
- 17:24:53.895. Handoff `uncertain`. Home item `uncertain:01M8F0CEQPEY2RDVPF5V2ZX3JQ`, "A Hermes handoff needs your
  decision". Chat message: "Hermes restarted during the run; whether its last step finished is not known. ... Side
  effects that already happened in Hermes are not undone." [p1-08-home.png](hermes-acceptance/p1-08-home.png),
  [p1-08-uncertain.png](hermes-acceptance/p1-08-uncertain.png).
- Reconcile view (`GET /api/hermes/handoffs/<id>/reconcile`): run status `unknown`, last tool started `terminal:
  sleep 55`, last tool finished `terminal`, and the stored messages (three finished `sleep 55`).
- 17:25:46 to 17:26:46: the Hermes session stayed at 8 messages, the run `unknown`, no new session, no pick. So no
  `resolve-unknown` and no new run before the user chose.
- 17:28:31. The user clicked "Mark as interrupted". Handoff `cancelled`, resolution `interrupted`; the Hermes run
  `cancelled`. No Home item left.

### 9. pi-spore restart

- 17:28:55. Handoff `01M8F0V3WE2M0NKVVV7A79SVS4`, run `run_22388e906bcc4e42bab212fd9d5bf484`: `sleep 5`, `sleep 90`,
  `sleep 5`.
- During step 2 the user ran `pi-spore restart` on the user's own server (uptime 11.7 s at 17:29:30). This chat
  restarted with it.
- 17:30:50. `completed`, reply `L9_FINISHED`. The session holds three `terminal` calls, one each; no new session.
  The chat got `L9_FINISHED` once.

### 10 to 14. Requests from Hermes

- 10 and 12. Run 1 of the Hermes chat session called `list_targets`, then `submit_request` `acc15-l10-20261127`
  twice with the same body. Both answers: `{"request_id":"acc15-l10-20261127","state":"pending",...}`. One row
  `01M8F08VPJGE2SZWJREQ45J7ZE` (17:18:56.722), one Home item `request:01M8F08VPJGE2SZWJREQ45J7ZE`.
- The user accepted by 17:19:16; the row went `running` with this chat as its agent. The chat answered with
  `reply_hermes` `L10_OK` at 17:19:41. `get_request` then gave
  `{"request_id":"acc15-l10-20261127","state":"completed",...,"result":"L10_OK"}`.
- 13. While working on that request, the chat called `ask_hermes`: refused, "This chat works on a request from
  Hermes, so it cannot ask Hermes (no loops) (hermes_refused)". No handoff was made.
- 11. `acc15-l11-20261127`, row `01M8F0AVKQBQ2H8K8XPE11QR1A` (17:20:02.167). The user declined at 17:20:08.
  `get_request`: `{"request_id":"acc15-l11-20261127","state":"cancelled",...,"reason":"Declined by the user"}`.
- 14. `acc15-l14-20261127` to `01M8NOTALLOWEDXXXXXXXXXXXX`: a tool error, `01M8NOTALLOWEDXXXXXXXXXXXX is not a target
  pi-spore allows; call list_targets`. No row, no Home item. A real workspace outside the list could not be tried
  without a config change: all three projects are allowed.
- The request message itself reached the chat after the chat had already answered it, because messages queue while
  the chat works. The chat did not answer twice.

### 15. Isolation

- 04:30:42, from the desktop. The `pi-spore` key on `/p/homelab-maintainer/api/sessions`: `401`
  `gateway_auth_failed`.
- `/p/pi-spore/api/sessions?limit=200`: 22 sessions, all source `api_server`, all ids `pi-spore-*` (handoffs,
  `pi-spore-chat-*`, and the setup sessions). None of `homelab-maintainer`'s.

### 16. Hermes off

- A sampler on the desktop counted TCP connections to `hermes-docker:8642` and listeners on `7430` twice a second.
- On (17:31:02 to 17:32:06): 1 to 5 connections, `7430` listening.
- The user set `hermes.enabled` to `false` and ran `pi-spore restart` (uptime 15.9 s at 17:32:22).
  `GET /api/hermes/status` `{"state":"disabled"}`, `GET /api/hermes/mcp` `{"state":"off"}`.
- Off, 17:32:28 to 17:35:39: 373 samples. `7430` listening in none. A connection showed in the first 7 samples
  (17:32:28 to 17:32:31), then none; at 17:32:33 `ss -tnp` showed no socket of the server process to Hermes. The
  first samples are most likely a socket from before the restart closing; the Hermes log below shows no request.
- Hermes API log for profile `pi-spore`, 17:32:00 to 17:36:00 (read by Homelab Maintainer for the user): "No pi-spore
  API access-log entries were recorded".
- 17:38:23. The user set `hermes.enabled` back to `true`: status `ready`, the listener `listening`.

### 17. Rollback on paper

Read once on 2026-11-27, 17:38 to 17:40, without changing anything. The desktop checks ran on the desktop; the
Unraid checks ran as one read-only handoff (`01M8F1DH0WSQ6S55DZQ89EYK87`, one `terminal` call, no approval, no file
content printed).

Card 1.4 ([runbook](../hermes/pi-spore-profile/runbook.md#rollback)):

| Step | Target now | Check |
| --- | --- | --- |
| Listener off | `hermes.mcp.enabled` true, `listening` | Line 16 showed the port closes when Hermes is off |
| MCP entry | `profiles/pi-spore/config.yaml`: one `  pi_spore:` line, one `PI_SPORE_MCP_TOKEN` reference; backup `config.yaml.before-hermes-1-4b` present | OK |
| Toolset | S4 changed nothing | Nothing to undo |
| Skill | `profiles/pi-spore/skills/pi-spore-remote-teammate` present | OK |
| Token on Unraid | one `PI_SPORE_MCP_TOKEN=` line in `profiles/pi-spore/.env` | OK |
| Token on the desktop | `~/.pi-spore/hermes/mcp.token`, `0600`, 65 bytes | OK |
| Transfer files | desktop `transfer/unraid-receive.pub`, `transfer/mcp.token.enc`; Unraid `transfer/` holds `mcp.token.enc`, `receive.key`, `receive.pub` | OK |
| Firewall rule | zone `tailscale` has the one rich rule for `7430` from `hermes-docker` | OK |
| Grant | not applied (S3 skipped) | Nothing to undo. `tailscale serve status` shows only the `7420` handler; no Funnel |

Finding: the runbook's rollback commands named `/opt/data/profiles/pi-spore/`. That folder does not exist; the profile
is at `/home/hermes/.hermes/profiles/pi-spore/`. `rm -rf` on the old skill path would have "worked" and removed
nothing. This change fixes the paths in the rollback table.

Card 0.4 has no rollback of its own; card Hermes 0.5 retires what it left. On paper:

| Step | Target now |
| --- | --- |
| Desktop key | `~/.pi-spore/hermes/pi-spore.key`, `0600`, 64 bytes. Removing it turns Hermes `unauthorized` |
| Desktop receiving pair and transfer files | `transfer/receive.key`, `receive.pub`, `ciphertext.bin`, `pi-spore.key.enc.b64`, `decrypt.err` present |
| Profile key on Unraid | revoke or rotate `API_SERVER_KEY` of `pi-spore`: an operator step for Homelab Maintainer, with a yes |
| Test session | `pi-spore-migration-1` still listed (line 15) |

### Follow-ups

- Bug card 01M8EZZQZE3TN1DW39P2Z0N30W: a clarify control shows the approval timeout (300 s), but Hermes waits 1
  minute (line 6).
- The approval Home item closes at expiry and shows no "expired" label; the handoffs page shows `expired`. Card line
  4 asked for "expired" on Home. Same as Phase 2 line 5.
- Line 5's user double-click shows that one approval reached Hermes; the browser side of the click was not recorded.
  The server guard was proved with two parallel API answers.
- Line 14 used an unknown id, not a real workspace outside the list.

## Phase 2: the Hermes chat page (card Hermes 2.3)

Run on 2026-11-27 (UTC). Times below are UTC.

- Hermes: `0.23.3` (`GET /p/pi-spore/health`), at `http://hermes-docker:8642`, profile `pi-spore`.
- pi-spore: commit `ff93b09` (main), the user's server on port 7420, restarted by the user on that commit.
- `hermes.enabled` set to `true` at 00:56:54 through `PUT /api/projects/settings`.
- The browser: headless Chromium (Playwright), 1440 x 1000, against `http://127.0.0.1:7420/`. The driver scripts
  lived outside the repo.
- Screenshots: [`hermes-acceptance/`](hermes-acceptance/). Logs below hold session ids and Home item ids, no keys.

| # | Check | Result |
| --- | --- | --- |
| 1 | `/hermes` on the desktop and the phone, `ready`, profile `pi-spore` | Pass |
| 2 | New project session, streamed reply, a tool row | Pass |
| 3 | Reload brings back the transcript | Pass |
| 4 | Inline approval: `deny`, then `once`; Home item closes | Pass |
| 5 | Unanswered approval expires and is blocked | Pass |
| 6 | Clarify round trip, inline | Pass |
| 7 | Stop a long run: `cancelled`, "not undone" note | Pass |
| 8 | Hermes gateway restart during a run | Pass |
| 9 | pi-spore restart during a run | Pass, on a second pi-spore instance (see below) |
| 10 | A session pi-spore did not make is read-only, with the reason | Pass for a handoff session and an `api_server` session from setup. No session from another source exists |
| 11 | `hermes.enabled` off: no rail entry, no traffic | Pass from the desktop side. Hermes API log not checked (the user skipped it) |

### 1. The page loads

- 00:57:05. Desktop, 1440 px: the status line reads "Profile pi-spore", chip `ready`, "Hermes 0.23.3".
  [01-desktop-hermes.png](hermes-acceptance/01-desktop-hermes.png).
- At 390 px (the phone width, but on the desktop) the page also loads. The top rail scrolls sideways there
  (`scrollWidth 352 > clientWidth 302`); that rail is a scroll area by design.
- About 01:24. Phone over Tailscale serve (`https://cachyos-x8664.tail60384b.ts.net/#/hermes`, ADR 0143): the user
  reports the chip `ready` and "Profile pi-spore". No phone screenshot was saved.

### 2. Session, streaming, tool row

- 00:58:09. New session "Acceptance 2.3 line 2", project "Pi Spore", id `pi-spore-chat-01M8D84ZECX19X97KC9KCR7SE7`.
- Prompt: run `pwd` and `date -u` with the terminal tool. Tool row `done terminal: pwd + 1 command`. Reply
  `/opt/data/pi-spore-bridge — Fri Nov 27 00:58:16 UTC 2026`. State `completed`.
  [02-done.png](hermes-acceptance/02-done.png).
- Provider and model shown: provider `unknown`, model `gpt-6.1-sol`. The Hermes run API leaves the provider blank
  (see [hermes-pi-spore-profile.md](hermes-pi-spore-profile.md)).
- Streaming, 01:06:53, session "Acceptance 2.3 line 2b streaming" (a 400-word reply): with the run `running`, the
  page text grew in steps every 0.7 s, from 189 to 2983 characters, before `completed` at 01:07:12.
  [02b-stream-2.png](hermes-acceptance/02b-stream-2.png).

### 3. Reload

- 00:59. A new page load of the line 2 session shows the user message, the tool result, and the reply from the
  Hermes history, and the run line `completed`, model `gpt-6.1-sol`. [03-reload.png](hermes-acceptance/03-reload.png).

### 4. Approvals

The command was a Python heredoc that writes one marker file in `/opt/data/pi-spore-bridge`. Hermes flags it as
"script execution via heredoc". Log (Home items are the `hermes` items of `GET /api/attention/inbox`):

```text
01:02:10.979Z session pi-spore-chat-01M8D8CBG7796PQN9SRHJFG41X
01:02:16.885Z deny approval shown; home items [{"id":"chat-control:01M8D8CBJTEQBHCVXV1HTFF8P4:0aa6...","title":"Hermes asks to run a command"}]
01:02:16.950Z deny clicked deny
01:02:20.494Z deny after answer; home items []
01:02:29.794Z once approval shown; home items [{"id":"chat-control:01M8D8CQN8D8Q7NQZWRNC8KSJ2:958e...","title":"Hermes asks to run a command"}]
01:02:29.883Z once clicked once
01:02:33.432Z once after answer; home items []
```

- Deny: tool result `exit_code -1`, "BLOCKED: Command denied by user." Hermes replied `BLOCKED`.
- Once: tool result `exit_code 0`, "Command required approval (script execution via heredoc) and was approved by
  the user."
- `ls -la /opt/data/pi-spore-bridge` afterwards lists only the approved files, `acc23-once.txt` (first try, 00:59)
  and `acc23-once-2.txt`. No `acc23-denied*.txt`. [04b-ls.png](hermes-acceptance/04b-ls.png).
- The control shows inline with "Allow once" and "Deny", and as a Home toast.
  [04b-deny-pending.png](hermes-acceptance/04b-deny-pending.png).
- The first try (00:59, session `pi-spore-chat-01M8D86N9Q8T26BZ45WTVHMVB8`) gave the same result; its Home log was
  lost, so the run was repeated.

### 5. Approval timeout

- 01:05:34. Approval shown, expires at 01:10:34 (300 s, the Hermes default). Not answered.
- 01:10:38. Tool result: "BLOCKED: Command timed out without user response." The page shows the tool row `failed`
  and "A Hermes request expired: python3 - <<'EOF' ...". Home items: none. No `acc23-expired.txt` in the folder.
  [05-expired.png](hermes-acceptance/05-expired.png).
- The Home item closes at expiry. It does not stay on Home with an "expired" label; the "expired" text is on the
  page.

### 6. Clarify

```text
01:05:28.238Z session pi-spore-chat-01M8D8JC4JM6VBC8MG9JMRHMHN
01:05:34.163Z clarify shown; home items [..., {"id":"chat-control:01M8D8JC75PVX5CTX45DKR09AA:33f226fded","title":"Hermes asks you a question"}]
01:05:34.243Z answered "pong"
01:05:37.791Z home items after: only the line 5 approval
```

- Tool result: `{"question": "ping or pong?", "choices_offered": ["ping", "pong"], "status": "answered",
  "user_response": "pong"}`. Reply `PONG`. [06-pending.png](hermes-acceptance/06-pending.png),
  [06-done.png](hermes-acceptance/06-done.png).

### 7. Stop

- 01:05:57. Three steps: `sleep 5`, `sleep 60`, `sleep 60`. At 01:06:13 step 1 is `done` and step 2 `running`.
- 01:06:13.990 Stop clicked. 01:06:14.995 the run shows `cancelled`, step 2 `failed` (`[Command interrupted]`,
  exit 130), and "Stopped. Steps Hermes completed are not undone." [07-cancelled.png](hermes-acceptance/07-cancelled.png).

### 8. Hermes gateway restart

- 01:26:45. Session "Acceptance 2.3 line 8 gateway restart" (`pi-spore-chat-01M8D9SBY6XQCPXQQ0FGSNF7GT`), 20 steps of
  `sleep 55`. A watcher recorded the open page every 3 s and did not click anything.
- About 01:27:30, the user ran `docker exec <container> hermes gateway restart` on Unraid during step 1.
- 01:27:46. Status `unreachable`, "Hermes at http://hermes-docker:8642 did not answer GET /health: ECONNREFUSED".
  The run still shows `running`. [08-outage.png](hermes-acceptance/08-outage.png).
- 01:28:01. Status `ready` again. The run shows "Reconnecting: The event stream of run run_07be... sent nothing for
  30 s; resume after event 0 or read the run". [08-reconnecting.png](hermes-acceptance/08-reconnecting.png).
- 01:28:04. The run is `unknown`: "Hermes restarted during the run; whether its last step finished is not known.
  Check what is known, then pick." and "Hermes holds this session until the lost run is marked as interrupted."
  A Home item "A Hermes chat run needs your decision" opened.
- 01:29:38. "Check what is known" shows: run status `unknown`, last tool started `terminal: sleep 55 + 1 command`,
  last tool finished: none seen, and the stored messages. The only action is "Mark as interrupted"; it was not
  clicked. [08-reconcile.png](hermes-acceptance/08-reconcile.png).
- 01:30:14. Still `unknown`. The Hermes session holds 2 messages (the one user message and an empty assistant
  message). Nothing was resolved or sent again. The Home item is still open, for the user.

### 9. pi-spore restart

The user's server must not be stopped by an agent. So this ran on a second pi-spore: the same build (`ff93b09`,
this worktree), its own home, port 7499, the same Hermes profile and key file.

- 01:12:27. Session "Acceptance 2.3 line 9 pi-spore restart", steps `sleep 5`, `sleep 40`, `sleep 5`.
- 01:12:37. Step 2 `running`. The server process was stopped (SIGTERM), then started again at 01:12:41. While it
  was down the page still showed `running` and `ready`; it showed no outage.
  [09-server-down.png](hermes-acceptance/09-server-down.png).
- The open page picked the run up again: step 2 `done` at about 01:13:20, step 3, then `completed` and
  `ALL_STEPS_DONE.` at 01:13:28. Nothing was sent twice. [09-recovered.png](hermes-acceptance/09-recovered.png).
- Seen on the way: after the reconnect, while the run was live, the user message showed twice (once from the
  stored history, once from the live run block). It showed once after the run ended. Bug card
  01M8D9T87TPD35YH7ZJK6KM5HR.

### 10. Read-only sessions

- No session on the profile has a source other than `api_server` (`GET /p/pi-spore/api/sessions`: 10 sessions, all
  `api_server`). So the "Owned by <source>" reason was not seen live.
- A card 1.2 handoff session: `ask_hermes` from this workspace at 01:06:30, handoff `01M8D8MPNJJ525B497E91RVV2X`. Its
  session shows the handoff text, the reply `HANDOFF_OK`, and "Read-only: A handoff session; read-only here." There
  is no message box. [10-handoff-readonly.png](hermes-acceptance/10-handoff-readonly.png).
- A setup session (`pi-spore-migration-1`) shows "Read-only: Not made by pi-spore's chat page."

### 11. Hermes off

- 01:15:20. `hermes.enabled` set to `false`. `GET /api/hermes/status` answers `{"state":"disabled"}`.
- The rail has no Hermes link (0 links to `#/hermes`). `/hermes` shows "Hermes is off."
  [11-off-hermes.png](hermes-acceptance/11-off-hermes.png).
- Traffic, sampled on the desktop with `ss` twice a second, TCP from the server process to `hermes-docker:8642`:
  on, 01:14:16 to 01:15:16: 7 of 114 samples had a connection. Off, 01:15:54 to 01:18:54: 0 of 342.
- 01:19:14. `hermes.enabled` set to `true` again.
- Hermes API log for 01:15:20 to 01:19:14: not checked. The user skipped it.

### Follow-ups

- Bug card 01M8D9T87TPD35YH7ZJK6KM5HR: the user message shows twice after a reconnect while a run is live (line 9).
- Not seen live: a session from a source other than `api_server` ("Owned by <source>"), and the Hermes API log for
  line 11.
- Line 9 ran on a second pi-spore instance, not on the user's server.
- While pi-spore itself was down (line 9), the open page showed no outage.
- The line 8 test session is left `unknown` with its Home item open. Marking it interrupted is the user's choice.
