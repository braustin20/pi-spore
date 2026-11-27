# Hermes live acceptance

Live checks of the Hermes integration (ADR 0202) against the real Unraid Hermes profile `pi-spore`. Fakes do not
count. Phase 1 (card Hermes 1.5, handoffs in both directions) is not written yet.

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
