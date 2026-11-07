# 0032. Agent tokens, bridge routes, and receipts through idempotency keys

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.2, R16.2, R16.3

## Context

spore-bridge tools in an agent call the server over HTTP. The user's API token can do everything, so it must never
reach an agent: an agent must not be able to act for another agent, another workspace, or the user. A tool call that
is replayed must get its first result (R16.3). The server already stores responses by `Idempotency-Key` (R16.2).

## Decision

- Each agent process gets its own random token in `PI_SPORE_TOKEN`, with the server's address in `PI_SPORE_URL`.
  The server keeps tokens in memory, by hash, with the agent and workspace they name. A token is revoked when its
  process exits. Agent processes end with the server, so no token outlives it.
- Routes under `/api/bridge/` (the `bridge` module) accept only agent tokens, as `Authorization: Bearer`. All other
  routes accept only the user's token. A bridge route acts for the calling agent and its workspace; it reads them
  with `bridgeCaller(c)` and never takes them from the request.
- A mutating bridge call sends the tool call id as its `Idempotency-Key`. The server stores it as
  `bridge/<agent id>/<tool call id>`, so the receipt key is the agent and the tool call, and agents cannot collide.
- Long actions are followed with short waits (`GET /api/bridge/runs/:id?wait=`) instead of one long request, so no
  HTTP client timeout cuts them off.

## Consequences

- A token found in an agent's logs opens only that agent's bridge routes, and only while its process runs.
- Receipts reuse the idempotency table: one mechanism, one place to keep in mind. A request still in flight is not a
  receipt yet, so two copies sent at the same time both run.
- New bridge routes go in the `bridge` module, which reaches other modules only through their interface keys.
