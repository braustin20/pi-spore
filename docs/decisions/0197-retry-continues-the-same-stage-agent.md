# 0197. Retry continues the same stage agent; Fresh agent replaces it

- Status: Accepted
- Date: 2026-11-23
- Requirements: R6, R6.6
- Changes: [0140](0140-pipeline-stage-agents.md) ("Failed agents"), [0169](0169-remind-a-stage-agent-once-then-block.md)
  (what Retry does)

## Context

ADR 0140 says Retry starts a fresh agent for a failed turn. The fresh agent gets only the brief, so it redoes the
work.

On 2026-11-24 (UTC) a worker had written its code, and its build passed. The next model call failed with a model server
error: `the engine stopped unexpectedly (exit code 1); the next request restarts it`. Pi stayed alive. One "continue"
to the same agent would have finished the turn. Retry threw that work away.

## Decision

- **Two choices.** A blocked stage turn shows two buttons. pi-spore does not sort errors; the user picks.
  - **Retry** (`POST /api/pipelines/runs/:id/retry`): the same agent continues. Its chat, context, and work stay.
    The turn stays open with its id and round. `await` sends the agent one message:
    `Your last turn failed: <failure>. This is attempt <N> of this turn.` and "Check where you stopped (git status,
    your last tool results), then finish the turn and call report with this turn as before." plus the `Turn:` line.
    If the agent's Pi process exited, the delivery starts it again on its session file.
  - **Fresh agent** (`POST /api/pipelines/runs/:id/fresh`): what Retry did before. The old agent is renamed
    `(failed)` and a fresh agent takes the turn. Use it when the model hit a usage limit or the agent loops.
- **Attempts.** `pipelines_turns.attempts` starts at 1 and goes up by one per Retry. The turn row shows
  `attempt N` from 2.
- **Messages.** Every block message ends with
  `Retry tells the same agent to continue. Fresh agent starts a fresh <role> agent for this turn.` A failure that is
  an assistant `stopReason: "error"` says `the model server <provider> failed for the <role> agent "<title>": <text>`,
  so the user does not think Pi crashed.
- **The mark waits.** Retry writes the raw failure to `pipelines_turns.retry_error`. `await` sends the message,
  raises `attempts`, sets `reminded` back to 0, and clears the mark in one commit. A paused run sends nothing until
  Resume (ADR 0187). After Resume, a turn with the mark gets the continue message and not the resume message.
- **No second block.** `turnError` is undefined while the agent has a delivery that waits with no error, or a prompt
  Pi took that has not started. So the old failure does not block the stage again before the agent runs.
- Both buttons work on task, fix, and review turns. The lanes card and `pi-spore pipeline retry` call Retry.

## Consequences

- A provider hiccup costs one message, not a new agent and its warm-up.
- An agent that fails the same way again blocks again. The user then picks Fresh agent.
- ADR 0169's block on a second end without a report stays. Its Retry now continues the same agent too.
