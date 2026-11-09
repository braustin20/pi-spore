# 0140. Pipeline stages run on stage agents; Jev answers inside the report tool

- Status: Accepted
- Date: 2026-11-07
- Requirements: R4.4, R4.9, R6.1 to R6.8

## Context

ADR 0006, 0015, and 0016 decide what a pipeline is, but not how a stage reaches an agent. Agents were only
workspace chats: one orchestrator chat and read-only side chats. The server cannot call the Jev classifier; only a
Pi process can (`ctx.modelRegistry.classify`). Deliveries to agents are at least once, so a report must be tied to
the prompt it answers.

## Decision

- **Stage agents.** A stage runs on an agent of kind `stage` with a role (`worker`, `reviewer`,
  `adversarial-reviewer`) and a fixed model. Reviewer roles are read-only like side chats and have the `report`
  tool. Each review round gets a fresh reviewer. The run keeps one worker agent; fixes go to it.
- **Turns.** Every prompt to a stage agent is a turn with an id, written with the agent and the delivery in one
  commit. The agent ends the turn with `report`. The server takes one report per turn, only from its agent.
- **Jobs.** Each stage is a job (ADR 0006). The turns table holds the stage's state, so a step that runs again reads
  where it is. After a restart a waiting stage asks its agent once to continue. There are no other reminders.
- **Jev.** The `report` tool asks Jev in the reviewer's Pi process, for a REVISE whose findings include none that is
  blocking. The answer goes with the report and is stored. The server stops the review early only when the stage
  has `early_stop = "jev"`, Jev says stop, and no finding is blocking. The worker then gets one last fix with no
  review after it. Jev never adds a round (ADR 0015).
- **Round limit.** A REVISE on the last round asks the user through an approval on Home, unless the stage has
  `fix_passes = 1`. The decision is stored on the run in the transaction that stores the approval's decision.
  The approval names the lane, and its choices are fix once, go on, or stop (2026-11-08).
- **Strength.** `min_strength_over` compares tiers (ADR 0023) before a reviewer starts, and again on its report
  with the models it really used. A stage agent's model cannot change.
- **Tiers.** Only `tier = "route"` (spore/auto) is built. Other tiers are an error until a tier-to-model choice is
  decided.

## Consequences

- Stage agents show as chat tabs, so the user can watch and steer them.
- A reviewer could report through a direct HTTP call with a made-up Jev answer. It has no shell, so this needs a
  tool it does not have. The blocking-finding veto still holds.
- Moving the card when a run passes and a tool for the orchestrator to start a run are later work.
