# 0203. The desktop firewall, not a Tailscale grant, limits the Hermes MCP port to `hermes-docker`

- Status: Accepted
- Date: 2026-11-26
- Requirements: R1.2, R19.4
- Changes: [ADR 0202](0202-hermes-remote-teammate.md) §10 in part ("The network rule for the listener (a Tailscale
  grant from Unraid to the desktop port)")

## Context

ADR 0202 §10 puts a second lock on the MCP listener: a Tailscale grant that lets only `hermes-docker` reach
`tcp:<hermes.mcp.port>` on the desktop. Runbook step S3 applies it.

During card Hermes 1.4b the user skipped S3 for good. The tailnet keeps its allow-all grant, which already covers every
device and port. A grant for one port would mean rewriting that rule for the whole tailnet.

The desktop runs firewalld. Its zone `tailscale` (on `tailscale0`) dropped the MCP port, so Hermes could not connect at
all (`[Errno 113]`). The fix was one rich rule that admits only `hermes-docker` on that port. That rule already does
what the grant was for.

## Decision

- The source lock for the MCP port is the desktop's host firewall: one rule that admits only the `hermes-docker`
  Tailscale address on `tcp:<hermes.mcp.port>`. On this desktop it is a firewalld rich rule in the zone `tailscale`.
- No Tailscale grant is required. The tailnet policy stays as the user keeps it.
- Everything else in ADR 0202 §10 holds: the listener binds the Tailscale address only, checks `Host`, refuses any
  `Origin`, takes only the MCP token, and caps body size and rate. No Funnel, and no Serve handler for this port.
- The operator applies and removes the firewall rule, with the user's yes. pi-spore never changes a firewall.

## Consequences

- One lock lives on the desktop, not in the tailnet policy. A second desktop, or a reinstall, needs the rule again;
  [network-rule.md](../hermes/pi-spore-profile/network-rule.md) says so.
- The tailnet policy has no `tests` entry for this port, so a policy save cannot catch a change. The firewall rule does
  not depend on the policy, so a policy change cannot open the port either.
- If the `hermes-docker` node gets a new Tailscale address, the rule must change with it, or Hermes cannot connect.
- The runbook's S3 records the skip. Its rollback removes the firewall rule.
