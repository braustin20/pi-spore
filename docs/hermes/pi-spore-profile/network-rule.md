# The network rule: only `hermes-docker` may reach the MCP port

Part of [runbook.md](runbook.md), step S3. Card Hermes 1.4,
[ADR 0202](../../decisions/0202-hermes-remote-teammate.md) §10. **This step has its own yes**: it changes the
tailnet's ACL policy, which affects every device. Nothing is applied here.

## Goal

One tailnet node, `hermes-docker` (the node the Hermes container is on), may open a TCP connection to the MCP port on
the desktop. Every other device on the tailnet may not. No Funnel, and no new Serve handler.

The listener already binds the desktop's Tailscale IPv4 address only, never `0.0.0.0`, and answers nothing but its own
`<ip>:<port>` as `Host`, with its own token. The grant is the second lock: with it, a stranger on the tailnet cannot
even complete a TCP connection, so the token is never the only thing between a random device and a `401`.

Placeholders: `<desktop-tailscale-ip>` is the desktop's Tailscale IPv4 address (the address the listener bound; see
[mcp-entry.md](mcp-entry.md)); `<hermes.mcp.port>` is pi-spore's setting for this port, default `7430`;
`tag:hermes-docker` is whatever the policy calls the Unraid node — a device name works too.

## The rule

Tailscale admin console → Access Controls, in the `acls` list, **above** any broad rule (such as one that grants
`*` to `*:*`):

```json
{
  "action": "accept",
  "src": ["tag:hermes-docker"],
  "dst": ["<desktop-tailscale-ip>:<hermes.mcp.port>"]
},
{
  "action": "reject",
  "src": ["*"],
  "dst": ["<desktop-tailscale-ip>:<hermes.mcp.port>"]
}
```

The narrow accept comes first, so `hermes-docker` is granted; the second line refuses that port to everyone else and
stops the rule walk, so no later broad rule can hand it back.

**Check before applying.** Tailscale documents `accept` and `reject`; a `deny` rule keeps evaluating later rules, so
`reject` is the form that cannot be undone by a rule below it. Whether this tailnet's policy file is JSON or HuJSON,
and how it names the Unraid node and the desktop address, is operator-side. Read the saved policy back after saving,
and paste that (redacted of device names you would rather not store) into the evidence table. If the deny test below
fails, the rule is wrong: stop and narrow the broad rule instead. Do not mark this step done on a failed test.

Do not add anything else:

- no Funnel for this port, ever (`tailscale funnel` publishes a public HTTPS URL; this token would then meet the
  open internet);
- no new `tailscale serve` handler for this port — the listener is reached directly over the tailnet;
- no rule that opens a port range, and no `*:*` addition;
- do not touch the existing rules for the desktop's main server. That stays as ADR 0143 has it.

## Tests, in order

The tests are the evidence. Run them after saving the policy and after the listener is up (step S1). A test that
answers `401`, `403`, `405`, or `415` proves the port **answered**: for the deny tests that is a failure, not a pass.

### 1. From `hermes-docker`, the port answers

Inside the Hermes container:

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  -X POST http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp
```

Expected `401`: reachable, and no token was sent. With the bearer token it answers `200` — that is step S6's check.

### 2. From another tailnet device, the port does not answer

From any other device on the same tailnet (a laptop, the phone, another container):

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  -X POST http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp
```

Expected: a timeout or "no route to host", and **no HTTP status**. Record the exact error line.

### 3. Nothing is funnelled, and nothing new is served

On the desktop:

```bash
tailscale funnel status
tailscale serve status
```

Expected: no Funnel at all, and **no handler for `<hermes.mcp.port>`**.

Note on the card's wording. The card asks that `serve status` "show nothing". The desktop already has a Serve handler
for pi-spore's main server on `7420`, from ADR 0143, and ADR 0202 keeps that as it is. So the check for this card is
"no Serve handler covers the MCP port", plus a before-and-after snapshot of `serve status` so the change of this card
is visibly nothing. If `serve status` on this machine shows only `7420`, that is the expected state, and the evidence
line says so.

### 4. The main server is unchanged

On the desktop:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/api/health
```

Expected: the same answer as before this card. The MCP listener is a separate port with a separate token; the main
server keeps its loopback, `Host`, and `Origin` guards (ADR 0143, ADR 0202 §10).

## Rollback

Delete both ACL lines for this port and save; Tailscale applies the new policy to the tailnet. Then confirm test 1
now fails from `hermes-docker` too. See [runbook.md](runbook.md#rollback).
