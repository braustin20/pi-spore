# Amendment 2026-11-26: the dedicated Hermes profile `pi-spore`

- Date: 2026-11-26
- Amends: [hermes-setup.md](hermes-setup.md) (card Hermes 0.1) and [hermes-protocol.md](hermes-protocol.md)
  (card Hermes 0.2). Those two docs stay as the record of what was planned and probed then. This doc adds newer
  facts and one correction. Where they differ, this doc wins.
- Decision that uses these facts: [ADR 0202](../decisions/0202-hermes-remote-teammate.md).
- Status: **operator setup done on Unraid; nothing probed from the desktop yet.**

## How each fact is marked

- **operator-reported, verified inside the container**: the operator (Homelab Maintainer, for the user) ran the
  check inside the Hermes container on Unraid on 2026-11-26 and reported the result. No pi-spore agent saw it.
- **operator-reported**: the operator reported a setting or an action. No check result came with it.
- **probed from the desktop**: a live request from the desktop by a card. **No fact in this doc has this mark yet.**
  Card Hermes 0.4 adds the first ones.
- **spike**: a fact from [hermes-protocol.md](hermes-protocol.md), probed on v0.23.3 against `homelab-maintainer`.

No key, token, or `Authorization` value appears in this doc.

## The profile

Operator-reported. Homelab Maintainer made a new profile `pi-spore` for pi-spore. It is not a clone of
`homelab-maintainer`. Do not make it again.

| Item | Value |
|---|---|
| Profile name | `pi-spore` |
| Profile API root | `http://hermes-docker:8642/p/pi-spore` |
| OpenAI-compatible base | `http://hermes-docker:8642/p/pi-spore/v1` |
| Advertised model id | `pi-spore` |
| Desktop key file (planned) | `~/.pi-spore/hermes/pi-spore.key`, folder `0700`, file `0600` |

The key is on Unraid only. The move to the desktop is **pending** (card Hermes 0.4). The old key
`~/.pi-spore/hermes/homelab-maintainer.key` from the spike is the old integration key. Card Hermes 0.5 retires it.

## What the profile does not have

Operator-reported. Nothing was cloned from `homelab-maintainer` or any other profile:

- no old conversations;
- no memories;
- no skills;
- no bot channels;
- no infrastructure credentials;
- no MCP entries.

The profile uses the shared model logins through Hermes's normal auth. Its only history is the setup tests below.

So the `pi-spore` profile is **not Homelab Maintainer's conversation**. It knows nothing that Homelab Maintainer
knows. No handoff from it to Homelab Maintainer exists.

## Not a sandbox

Operator-reported. The profile isolates **history and config only**. It does not isolate the OS or the file system.
Its terminal runs inside the Hermes container with the `local` backend. It can reach other files in that container.
No doc or UI may say that the profile is a sandbox.

## Auth isolation

Operator-reported, verified inside the container.

| Request | Result |
|---|---|
| `pi-spore` key on `/p/pi-spore/v1/capabilities` | 200 |
| no key on `/p/pi-spore/...` | 401 |
| `pi-spore` key on the default profile's endpoint | 401 |
| `pi-spore` key on `/p/homelab-maintainer/...` | 401 |
| default profile key on `/p/pi-spore/...` | 401 |
| `homelab-maintainer` key on `/p/pi-spore/...` | 401 |

Not yet checked from the desktop (card Hermes 0.4).

## Profile config

Operator-reported.

```yaml
approvals:
  mode: manual
  unattended_mode: deny
  single_query_mode: deny
  cron_mode: deny
command_allowlist: []
terminal:
  backend: local
  cwd: /opt/data/pi-spore-bridge
```

- API toolsets: `terminal` and `clarify` only.
- Hermes docs: `manual` asks for every command Hermes flags as dangerous. With `command_allowlist: []`, no flagged
  command is allowed ahead of time.

## Model routing

Operator-reported, verified inside the container.

- Primary: provider `nous`, model `openai/gpt-6.1-sol`.
- `fallback_providers: [{"provider": "openai-codex", "model": "gpt-6.1-sol"}]`.
- A fresh API request used the fallback and returned `PI_SPORE_FALLBACK_OK`. Its session record showed:
  - `billing_provider: openai-codex`;
  - `model: gpt-6.1-sol`;
  - `gateway_runtime.fallback_active: true`.
- The run API's runtime provider and model fields were **blank** in this build. Blank fields are not proof that
  routing failed. Read the provider and model from the session record.

So Codex `gpt-6.1-sol` is the configured **fallback**, not the primary. Hermes owns this routing. pi-spore does not
change it (ADR 0202).

## Approval test

Operator-reported, verified inside the container. Nondestructive, on `pi-spore`, through the raw API (not through
pi-spore):

1. A print-only Python heredoc reached run status `waiting_for_approval`.
2. A pending approval control appeared.
3. `deny` answered HTTP 200.
4. The terminal tool recorded `exit_code=-1` and "BLOCKED: Command denied by user."

So on this profile the approval gate asks, and `deny` blocks.

## Correction of the spike's approval finding

[hermes-protocol.md](hermes-protocol.md) Q5 and Gap 1 say that a flagged `rm -r` ran with no prompt on
`homelab-maintainer`, and call this a security finding. That observation stays true. The conclusion changes:

- `homelab-maintainer` used `approvals.mode: smart` (operator-reported). `smart` can approve a low-risk flagged
  command on purpose. The spike already lists this as one of the skip branches.
- Which branch ran is **not known**. So the run does not by itself prove a bypass.
- Read "the approval system is broken" as: **not proven either way on `homelab-maintainer`**. The open approval items
  are acceptance items of card Hermes 1.5 (below). Gap 1 no longer blocks the phases on the `pi-spore` profile, but
  no phase that runs tools is done until card Hermes 1.5 proves them.

## Not changed

Operator-reported. The setup did not change:

- the Hermes dashboard;
- Tailscale;
- any listener;
- Docker;
- the approval settings of existing profiles.

No desktop MCP connection exists yet.

## Dashboard (port 9119)

Operator-reported, verified inside the container.

- Port 9119 listens on all container interfaces.
- An anonymous request to `/` reaches a login page.
- `/api/status` shows operational metadata.

This proves no auth bypass and no WAN exposure. pi-spore does not use the dashboard. The operator review is card
Hermes 0.6, separate from pi-spore's work.

## Not yet verified

Do not mark these done until a card proves them:

- desktop reach of `/p/pi-spore` with the `pi-spore` key, and the auth table above from the desktop (card 0.4);
- the key move to the desktop (card 0.4);
- a positive human approval (`once`) that allows only the intended step (card 1.5);
- the approval timeout: an unanswered approval is blocked after `approvals.timeout` (card 1.5);
- approval and clarify round trips through the pi-spore UI (card 1.5);
- a clarify round trip at all: `clarify.request` on `/v1/runs`, then an answer (card 1.5);
- the Hermes-to-Pi MCP listener and its Hermes `mcp_servers` entry (cards 1.3, 1.4, 1.5);
- the Hermes version on the container today. The spike saw 0.23.3. This setup did not report one.

## What happens to the spike's gaps

| Spike gap | Now |
|---|---|
| 1. Dangerous commands run without approval | Corrected above. `deny` blocks on `pi-spore`. The rest is card 1.5. |
| 2. The key reads every session of the profile | Accepted: the `pi-spore` profile holds only pi-spore and setup-test sessions (ADR 0202). |
| 3. Dashboard on 9119 | Card 0.6. No auth bypass shown. |
| 4. Clarify is off | The `clarify` toolset is on for `pi-spore` (operator-reported). Round trip not verified. |
| 5. Listener needs setup | Still open: cards 1.3 and 1.4. |

The Evidence table of [hermes-setup.md](hermes-setup.md) was never filled in. The spike's probes reached
`homelab-maintainer` from the desktop, so the desktop did reach port 8642 on 2026-11-25. The other checks of that
table (LAN refusal, other tailnet devices, Funnel, the published ports) are still not recorded.
