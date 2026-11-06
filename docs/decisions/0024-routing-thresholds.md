# 0024. Starting router thresholds and spill to Codex

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.2, R4.3, R4.10

## Decision

- Jev asks four choice questions: bounded, explicit requirements, visual, straightforward. A task goes local only
  if every "good" answer is at least 0.7, or 0.55 under usage pressure.
- The brief plus the files it names must fit in 50% of the local model's context.
- All thresholds are settings. Retune them from recorded outcomes after about 30 routed tasks.
- When the Claude 5-hour window is at 100% and a task cannot go local, the router uses an OpenAI Codex model of
  the same tier if its plan has room. The choice is shown in the UI. If no plan has room, the task waits for the
  first reset.

## Consequences

- Early on, some small tasks still go to cloud. That is the intended bias.
- Spilling to Codex depends on Codex usage numbers ([Q11]). Until they exist, the router treats Codex as having
  room and records that it did not know.
