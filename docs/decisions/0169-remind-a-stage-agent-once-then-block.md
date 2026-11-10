# 0169. Remind a stage agent once when it ends a turn without a report, then block

- Status: Accepted
- Date: 2026-11-10
- Requirements: R6, R6.6

## Context

ADR 0140 says a waiting stage reminds its agent only after a restart: "There are no other reminders."

Run 01M71N1RVX5688SD680NDVVJMR hung for over an hour. A small model ended its fix turn with thinking only and never
called `report`. The `await` step waited for a report that could not come, and nothing told anyone.

## Decision

- When the open turn's agent has ended its run without a report, the `await` step sends one reminder:
  "You ended your turn without calling report. Finish the work, then call report with this turn." plus the
  `Turn:` line.
- The checkpoint field `reminded` holds the turn that got it. One reminder per turn, also across a restart.
- If the agent ends its turn again without a report, the step throws
  `stage <name>: the <role> agent "<title>" ended its turn twice without a report. Retry starts a fresh <role> agent for this turn.`
  The stage blocks like a failed turn (ADR 0140): the run shows `blocked`, the asking chat is told, and Retry starts
  a fresh agent.
- The restart reminder (R6.6) is unchanged and comes first.

## Consequences

- A hung run now ends in `blocked` after at most two ended turns, not in silence.
- An aborted or running agent gets no reminder.
- This replaces the line "There are no other reminders" of ADR 0140.
