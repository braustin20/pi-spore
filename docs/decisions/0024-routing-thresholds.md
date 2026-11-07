# 0024. Starting router thresholds and spill to Codex

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.2, R4.3, R4.10

## Decision

- Jev asks four choice questions: bounded, explicit requirements, visual, straightforward. A task goes local only
  if every "good" answer is at least 0.7, or 0.55 under usage pressure.
- The brief plus the files it names must fit in 50% of the local model's context.
- All thresholds are settings. Retune them from recorded outcomes after about 30 routed tasks.
- The visual question always needs 0.7. Pressure lowers the other three only.
- When a fresh window of the Claude plan is at 100% (5-hour or weekly) and a task cannot go local, the router uses
  the first `router.spill` model on another plan in the same tier, if that plan has room. The choice is shown in the
  chat and recorded. If no plan has room, the request ends with an error that names the first reset, and no route is
  stored; the next message routes again. Blocking a request for hours inside the router would hold the agent and its
  lock.

## Consequences

- Early on, some small tasks still go to cloud. That is the intended bias.
- Codex numbers come from the usage tap when Pi uses the `openai-codex` provider (spike
  [Q11](../spikes/q11-codex-plan-windows.md)). The user's `openai` login reports none. Without fresh numbers the
  router treats Codex as having room and records "usage unknown".
