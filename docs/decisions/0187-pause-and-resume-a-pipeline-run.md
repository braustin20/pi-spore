# 0187. Pause and resume a pipeline run

- Status: Accepted
- Date: 2026-11-16
- Requirements: R6, R6.6, R7

## Context

On 2026-11-14 the user told a worker in its stage chat: "Pause here for now, I need to step away for a bit." The
worker obeyed its rules, ended the turn with `report`, and wrote "Paused at the user's request … Not done". The
pipeline took the report as a finished fix and started review round 2 on unfinished work. The only stop was Cancel,
which ends the run for good. A message in a stage chat cannot stop the pipeline, and the server does not read the
meaning of a message.

## Decision

- **Pause.** The Pipeline tab shows Pause next to Cancel on a `running` run. `POST /runs/:id/pause` sets
  `paused_at` on the run. The open turn is not cut off: its agent may finish and report, and the report is kept.
  The gate actions that run go on. The stage job starts no turn, reviewer, fix, gate round, or next stage while
  the run is paused: each step (`advance`, `await`, `decide`, `finish`) waits when it sees the pause.
- **Resume.** `POST /runs/:id/resume` clears `paused_at` and wakes the stage job. The job goes on from its step.
- **A flag, not a state.** The run stays `running` with a `paused` flag in its view. Reports, questions, Retry,
  Cancel, the one-active-run index, and the runs module's lanes all read `running` and stay as they are. A new state
  `paused` would need each of these places to learn it. A lane's run is not passed or failed while it is paused,
  because only `endRun` ends it.
- **Stop during a pause.** The chat's Stop button aborts the open turn. `await` does not remind and does not block
  while the run is paused, so a turn that ends or is aborted during the pause does not count toward the ADR 0169
  block. The first `await` after Resume sends each open turn's agent that is not busy and has no open question
  one message: "The user resumed the pipeline. Finish the work, then call report with this turn." plus the `Turn:`
  line, and sets the turn's `reminded` back to 0. The same agent goes on: it keeps its context and costs nothing to
  start. A fresh agent would lose the work of the turn. If the agent then ends without a report, ADR 0169 applies
  as usual. A busy agent gets no message; it reports when its turn ends.
- **Restart.** `paused_at` is a column, so a paused run stays paused after a restart. The resume message also
  covers the restart reminder (R6.6): it is sent once on the first `await` after Resume.
- **What the user sees.** The run chip says `Paused`. The step bar shows the current stage with a pause icon, not a
  spinner. The workspace status line and the asking chat's working label say `Pipeline paused`, so Home lists
  nothing new for the run: the user paused it on purpose.
- **Stage chat note.** While a stage chat's run is running and not paused and the chat has an open turn, the chat
  shows above its composer: "The pipeline goes on after this turn. To stop it, use Pause on the Pipeline tab."
  The note does not read the user's message.
- **Only the user pauses.** Agents get no pause tool.

## Consequences

- The user can step away without losing the run or its turn.
- A report written during a pause is taken as it is. If the agent was told to stop and reported "Not done", the
  pipeline still moves on after Resume. The user who wants the turn to go on uses Pause and leaves the agent alone,
  or uses Stop and Resume.
- A paused run holds the workspace: a new run still answers 409 until the paused run ends.
