# Spike Q11: Codex plan windows

- Date: 2026-11-06
- Method: read pi-ai 1.5.0's OpenAI providers, read Codex's open source client (`codex-rs/codex-api/src/rate_limits.rs`),
  read the user's Codex CLI session files, and make one real request (`openai/gpt-6-luna`, one word) with an extension
  that logged response headers and stream events. Cost: a few thousand tokens of ChatGPT plan quota, no money.
- Question: where do Codex 5-hour and weekly numbers come from in Pi? (ADR 0022, ADR 0024)

## Answer

- **The user's `openai` login reports nothing.** Pi's `openai` provider with "Sign in with ChatGPT" sends requests to
  the Responses API. The real response had no plan-window headers (only `x-codex-turn-state`, request ids, and
  Cloudflare headers) and no rate-limit stream events. Today, Codex numbers cannot be seen passively in the user's
  setup.
- **Pi's `openai-codex` provider is where they would appear.** It talks to the ChatGPT backend that the Codex CLI
  uses. Codex's own client reads two sources there:
  - HTTP headers `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, and
    the same for `secondary`. Used percent is 0 to 100; reset is epoch seconds. Pi passes headers to
    `after_provider_response` only on its SSE transport.
  - A `codex.rate_limits` stream event (`rate_limits.primary` and `.secondary` with `used_percent`,
    `window_minutes`, `reset_at`), sent over WebSocket, where there are no headers. Pi's default Codex transport is
    WebSocket; every stream event reaches `provider_stream_event`.
  - Primary and secondary are not fixed to 5 hours and a week. The window length says which is which: 300 minutes is
    the 5-hour window, 10080 minutes the weekly one. A Plus plan can report only a weekly window.
  The user has no `openai-codex` login, so this was not checked live. A third-party report says newer Codex servers
  send the numbers only from a separate usage endpoint (`/backend-api/wham/usage`); that would be active polling.
- **Codex CLI session files** (`~/.codex/sessions/**/rollout-*.jsonl`) carry `token_count` events with a
  `rate_limits` object of the same shape. The user's files from August 2026 have it; the recent ones do not, so it is
  not a reliable source.

## What pi-spore does

- The usage tap reads both Codex sources: `x-codex-*` headers on `after_provider_response` and `codex.rate_limits`
  events on `provider_stream_event`. It writes them to `~/.pi-spore/usage/codex.json`, naming windows `5h`, `7d`, or
  `<minutes>m`. If the user logs in to `openai-codex`, numbers appear with no code change.
- Until then Codex has no fresh numbers. The router treats it as having room and records "codex usage unknown,
  treated as room" (ADR 0024).
- Polling `/backend-api/wham/usage` was a v2 option; ADR 0153 builds it (see the result below). Reading Codex CLI
  session files stays unbuilt.

## Result (2026-11-08)

- Pi's `openai` login gets 401 on `/backend-api/wham/usage`. Its token is for `api.openai.com/v1`.
- The Codex CLI login (`~/.codex/auth.json`, with `Authorization: Bearer` and `ChatGPT-Account-ID`) gets 200.
- Fields used: `rate_limit.primary_window` and `rate_limit.secondary_window`, each with `used_percent`,
  `limit_window_seconds`, and `reset_at` (epoch seconds). Windows are named by length: 18000 s is `5h`, 604800 s is `7d`.
