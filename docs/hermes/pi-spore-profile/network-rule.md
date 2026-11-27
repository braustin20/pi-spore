# The network rule: only `hermes-docker` may reach the MCP port

Part of [runbook.md](runbook.md), step S3. Card Hermes 1.4,
[ADR 0202](../../decisions/0202-hermes-remote-teammate.md) §10. **This step has its own yes**: it changes the
tailnet's policy, which affects every device. Nothing is applied here.

## Goal

One tailnet node, `hermes-docker` (the node the Hermes container is on), may open a TCP connection to the MCP port on
the desktop. Every other device on the tailnet may not. No Funnel, and no new Serve handler.

The listener already binds the desktop's Tailscale IPv4 address only, never `0.0.0.0`, and answers nothing but its own
`<ip>:<port>` as `Host`, with its own token. The grant is the second lock: with it, a stranger on the tailnet cannot
even complete a TCP connection, so the token is never the only thing between a random device and a `401`.

Placeholders: `<desktop-tailscale-ip>` and `<hermes-docker-tailscale-ip>` are the two Tailscale IPv4 addresses (the
desktop's comes from the address the listener bound; see [mcp-entry.md](mcp-entry.md)); `<hermes.mcp.port>` is
pi-spore's setting for this port, default `7430`; `desktop` and `hermes-docker` are the names the policy file gives
those two nodes — a `hosts` alias, a device name, or a tag, whatever the rest of the file uses.

## The desktop's own firewall comes first

A host firewall on the desktop can drop the port before Tailscale policy matters. On 2026-11-26 the desktop's
firewalld zone `tailscale` (on `tailscale0`) did not allow `7430/tcp`, so `hermes-docker` got `[Errno 113]` and Hermes
parked the server. The fix was one rich rule that admits only `hermes-docker`:

```bash
sudo firewall-cmd --permanent --zone=tailscale \
  --add-rich-rule='rule family="ipv4" source address="<hermes-docker-tailscale-ip>/32" port port="<hermes.mcp.port>" protocol="tcp" accept'
sudo firewall-cmd --reload
```

That rule is also the source lock while the Tailscale grant below is not applied ([runbook.md](runbook.md), S3).

## How a Tailscale policy works here, and what that means

Tailscale policy is **additive and deny-by-default**: rules and grants only `accept`, there is no `deny` or `reject`
rule, and anything no rule accepts is already blocked. So:

- One narrow grant is the whole allow-list for this port.
- **A broad rule cannot be worked around by adding a rule under it.** If any existing rule or grant already accepts
  this port for others — a `*` → `*:*` rule, or a member-wide grant — that rule is what lets them in, and the only
  fix is to narrow that rule itself. Narrowing every overlapping allowance is therefore the main step, not a fallback.
- A `tests` block is what keeps it true later: Tailscale runs the tests on every save and refuses a save that breaks
  one, so a later edit that reopens this port is rejected instead of discovered months later.

## The change, in order

Read the current policy out of the Tailscale admin console first and keep a copy as the "before" evidence.

1. **Find every rule or grant that matches this port for anyone other than `hermes-docker`.** Look for `*`,
   `autogroup:member`, `autogroup:admin`, any group or tag that contains another device, and any `ip` or `dst` entry
   with `*` or a port range covering `<hermes.mcp.port>`, on either side.
2. **Narrow each one** so it no longer covers this port on the desktop — exclude that destination, drop the port from
   the range, or narrow the source list. Change nothing else; in particular leave the desktop's main-server rules as
   ADR 0143 has them.
3. **Add the one narrow grant for this port.** A grant keeps the destination identity and the protocol and port apart:
   `dst` names the node, `ip` names `tcp:<port>`. Same shape as
   [hermes-setup.md](../../spikes/hermes-setup.md) §1.7, which uses it for the reverse direction:

   ```jsonc
   {
     "hosts": {
       "desktop": "<desktop-tailscale-ip>",
       "hermes-docker": "<hermes-docker-tailscale-ip>"
     },
     "grants": [
       // Only the Hermes container's node may reach the pi-spore MCP port on the desktop.
       { "src": ["hermes-docker"], "dst": ["desktop"], "ip": ["tcp:<hermes.mcp.port>"] }
       // ... your other rules ...
     ]
   }
   ```

   `ip: ["tcp:<hermes.mcp.port>"]` is what makes this TCP-only and this-port-only: no `udp`, no range, no `*`.
   The `hosts` names stand for the two Tailscale IPv4 addresses; if the desktop is ever removed from the tailnet and
   added back, its address changes and `hosts` has to be updated — and the listener URL in step S4 with it.

   If this tailnet's policy still uses the older `acls` section, the same rule is the port-qualified form the spike
   shows for it — `dst` carries the port there, unlike `grants`:

   ```jsonc
   { "action": "accept", "src": ["hermes-docker"], "dst": ["desktop:<hermes.mcp.port>"] }
   ```

   Use whichever section the file is written in, and keep it consistent with the rest of the file. Do not mix them:
   an `acls` rule cannot go in `grants`, and a grants entry does not take a port in `dst`.

4. **Add the tests.** One accept for the node that must reach it, and one deny for **every other device** — each one
   named, because `autogroup:member` cannot be used in a deny test here: it contains `hermes-docker` too, so that test
   would fail against a correct policy.

   ```jsonc
   "tests": [
     { "src": "hermes-docker", "accept": ["desktop:<hermes.mcp.port>"] },
     // Repeat for each other tailnet device or user you have, for example a phone:
     { "src": "<other-user-or-device>", "deny": ["desktop:<hermes.mcp.port>"] }
   ]
   ```

   In a `tests` entry the `dst` is `<host>:<port>` in both policy styles.

   Enumerate the other devices from the admin console's machine list at apply time and add one deny test each: every
   other tailnet node, container host, phone, and laptop. A device that shares a node is not a separate source — see
   the test note below.

**Check before applying.** The names this file uses for the two nodes (`hosts` aliases, tags, or bare device names) are
operator-side, and the admin console validates the policy on save — that validation is the check. If the console
rejects the shape above, use the form the console's own editor documents, keep the meaning (one narrow TCP grant for
this port to one node, one deny test per other device), and record the saved text in the evidence table rather than
inventing a variant.

Do not add anything else:

- no Funnel for this port, ever (`tailscale funnel` publishes a public HTTPS URL; this token would then meet the open
  internet);
- no new `tailscale serve` handler for this port — the listener is reached directly over the tailnet;
- no rule that opens a port range, and no new `*:*` anything;
- no `autogroup:*` source on the accept.

## Tests, in order

The policy `tests` prove the rules. The live checks below prove the running tailnet and the listener. A live check
that answers `401`, `403`, `405`, or `415` proves the port **answered**: for the deny checks that is a failure, not a
pass.

### 1. From `hermes-docker`, the port answers

Inside the Hermes container:

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  -X POST http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp
```

Expected `401`: reachable, and no token was sent. With the bearer token it answers `200` — that is step S6's check.

### 2. From another tailnet node, the port does not answer

Run this **immediately after test 1 passes**, so a dead listener cannot be mistaken for a deny: if the listener is
off, `sync` has closed it and every client gets "connection refused", which looks exactly like a blocked port.

The other device must be a **different tailnet node**. Another container on Unraid usually leaves the tailnet through
the `hermes-docker` node, so a check from there measures that node's reach, not the container's: it can fail on a
correct policy, or pass for the wrong reason. A laptop, the phone, or another host's tailnet node is the right source.

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  -X POST http://<desktop-tailscale-ip>:<hermes.mcp.port>/mcp
```

Expected: a timeout or "no route to host", and **no HTTP status**. Record the exact error line, and record which
device ran it. Run it once per other device the policy names in its deny tests, or once for each distinct node plus a
note of which nodes were covered.

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

Order matters, because the policy will stop proving anything once the broad rules come back.

1. Turn the listener off first (pi-spore Settings, `hermes.mcp.enabled: false`). The settings check closes the port,
   so a client gets "connection refused". Confirm that from `hermes-docker`: test 1 must fail **while the grant and the
   tests are still in place**. That is the last piece of policy evidence you can collect.
2. Then delete the grant and the `tests` entries for this port, and restore each rule you narrowed. Save.
3. Confirm the saved policy matches the "before" copy you kept, apart from anything unrelated that moved in the
   meantime. Diff the two texts and keep that as the restoration evidence.

Expect the port to answer again from every node after step 3: a broad rule that allows it does so for all of them, and
restoring it restores that reach. That is why step 1 comes first. Once the broad allowances are back, the only thing
keeping the port closed is the listener being off — so a later "denied" result proves the shutdown, not the policy, and
must not be recorded as a deny test. See [runbook.md](runbook.md#rollback).
