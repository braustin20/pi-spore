# 0201. Nudge a stage agent once on a model server error, then block

- Status: Accepted
- Date: 2026-11-24
- Requirements: R6, R6.6
- Changes: [0198](0198-retry-continues-the-same-stage-agent.md) ("pi-spore does not sort errors")

## Context

Model servers fail for a moment. On 2026-11-24 (UTC) `unraid-strata` ended a worker's turn with
`the engine stopped unexpectedly (exit code 1); the next request restarts it`. Pi stayed alive. The server itself said
the next request works, but the stage blocked until the user came back and clicked Retry.

Pi has its own retry (`retry.enabled`, `retry.maxRetries` = 3 in pi-coding-agent 1.5.0). It retries only errors that
match pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`: words such as `overloaded`, `server error`, `timeout`, or a status
code such as `500`. The text above has none of them, so Pi did not retry. No Pi setting adds patterns.

ADR 0169 already sends one reminder before it blocks a turn that ended without a report. The same rule fits here.

## Decision

- **One nudge.** When an open turn's agent is alive and its last assistant message has `stopReason: "error"` (a
  `turnError` with a `provider`), `await` delivers one message to the same agent:
  `Your model call failed: <error>.` and "Check where you stopped (git status, your last tool results), then finish the
  turn and call report with this turn." plus the `Turn:` line. The turn's `error_nudged` column goes to 1 in the same
  commit. The stage does not block.
- **Then block.** A second model server error in the same turn blocks the stage as ADR 0198 says. Retry sets
  `error_nudged` back to 0, so each attempt gets one nudge.
- **No nudge on a usage limit.** A usage limit resets after hours, so a nudge only fails again. An error whose text
  matches `usage limit`, `quota`, `billing`, `out of budget`, `available balance`, or `insufficient_quota` blocks at
  once. These words follow pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`. The user picks Fresh agent.
- **Other failures block at once.** A crash, a Pi process that exited, and a task Pi refused have no `provider`.
- A paused run nudges no one (ADR 0187). After a restart or a Resume, that message covers the nudge, and
  `error_nudged` stays as it was.

## Consequences

- A short model server failure costs one message, and the user does not have to come back.
- An error that Pi retried three times gets one more try from pi-spore. That is a few seconds more before the block.
- A new usage-limit text that misses the list gets one nudge, which fails, and then the stage blocks.
