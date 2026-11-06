# Spike Q3: Strata concurrency

- Date: 2026-11-06
- Method: read the Strata server source (`serve/server.py`) and the user's service config. No live test, so the
  GPU model was not loaded.
- Question: what does Strata do with a second request while one is running? (ADR 0010)

## Answer

- The server runs one sequence at a time behind a FIFO queue. A second request waits until the first finishes.
- Queue limits are opt-in (`--max-queue`, `--queue-timeout`). The user's service sets neither, so a waiting
  request is never rejected and has no wait deadline. With limits set, an over-limit or expired request gets an
  error with code `queue_wait_timeout` (HTTP 429 style, `Retry-After: 1`).
- A streaming request that waits gets a keep-alive every 10 s, so client read timeouts do not fire while it waits.
- Batch slots (`--batch`) and a multi-conversation cache (`--conversation-cache-slots`) exist but are not enabled
  in the user's config. Without them, switching between two conversations makes the engine process the whole
  prompt again, up to the 128k context.

## Consequences for pi-spore

- The slot lock in ADR 0010 is still needed. It is not there to prevent errors. It keeps one session on Strata for a
  whole stage, so two sessions do not make the engine reprocess long prompts on every turn.
- pi-spore treats `queue_wait_timeout` as "busy, retry", in case queue limits are turned on later.
- If the user later enables `--conversation-cache-slots`, the slot could be released between turns. That is a
  later tuning step, not v1.
