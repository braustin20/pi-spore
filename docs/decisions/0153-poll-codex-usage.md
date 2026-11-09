# 0153. Codex usage is polled with the Codex CLI login

- Status: Accepted; changes [0022](0022-usage-tracking.md) for Codex
- Date: 2026-11-08
- Requirements: R18.1, R18.3, R18.5, R4.10

## Context

ADR 0022 read plan usage from response headers only. A user who signs in to Pi's `openai` provider gets no `x-codex-*`
headers and no `codex.rate_limits` events (spike Q11), so Codex usage was never seen. The router read "codex usage
unknown, treated as room" and kept sending work to a plan that was full. On 2026-11-08 the 5-hour window sat at 100%
while runs went on failing with a usage limit error.

Checked on 2026-11-08, with no token printed:

- The `openai` login's token has the audience `api.openai.com/v1`. ChatGPT's usage page, `GET
  https://chatgpt.com/backend-api/wham/usage`, answers it 401.
- The Codex CLI's own login (`~/.codex/auth.json`) answers 200 with the plan type and the `primary_window` and
  `secondary_window` of the plan.

## Decision

- The `usage` module runs a durable job, `usage.codex-poll` (ADR 0004), that asks the usage page once a minute and
  merges the answer into `~/.pi-spore/usage/codex.json` with `writeReading`. The router reads that file as before, so
  a full window stops it from choosing Codex (R4.10).
- The login is read from `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`, on every poll. It is only read. pi-spore
  never refreshes the token and never writes to `~/.codex`, because a refresh rotates the refresh token and could end
  the user's Codex CLI login.
- A failed poll does not end the job. The error shows on the Usage page (`errors` of `GET /api/usage/plans`) and is
  logged when it changes. It never holds the token, the account id, or the response body.
- Claude stays passive.

## Consequences

- The usage page is not a documented API. It can change, or sit behind Cloudflare. The poll then fails and the page
  says so; the router goes back to "unknown".
- When the Codex CLI login is old, the poll answers 401 and the page says to run `codex` once. pi-spore does not do it.
- The poll also counts use from the Codex CLI and other tools (R18.3).
