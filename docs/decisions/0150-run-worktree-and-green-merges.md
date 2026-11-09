# 0150. The coordinator works in the run's worktree; a merge commits only after its gates pass

- Status: Accepted; coordinator card tools in [0154](0154-coordinator-adds-cards.md)
- Date: 2026-11-08
- Requirements: R7.1 to R7.6, R4.8, R9.3

## Context

ADR 0007 and 0017 settle runs, lanes, and one integration branch. The first sketch put the coordinator in the main
checkout. Merges and gates then need a second worktree on the integration branch, and the coordinator reads code that
is not the integrated code. A gate failure after a merge must not leave a broken integration branch for the next
wave to start from.

## Decision

- **Run workspace.** A run creates `run/<slug>-<id>` from its base and one workspace on that branch (isolation
  `existing`, with the run's base). Its orchestrator chat is the coordinator. pi-spore merges lanes there, runs the
  run's gates there, and the user opens the one PR from its PR tab.
- **Read-only coordinator.** The coordinator chat has a tool allowlist without write or shell tools: read tools,
  artifacts, `request_human_input`, and the run tools. Its bridge token is not read-only, so it can write artifacts
  and call the run tools. The allowlist is the gate (ADR 0033).
- **Launch context.** The agents module asks registered hooks for extra env and a tool allowlist when it launches an
  agent. The runs module uses this for the coordinator and for lane agents (`PI_SPORE_RUN_ID`, `PI_SPORE_RUN_ROLE`),
  so run data stays in the runs module's tables.
- **Green merges.** `merge_lane` merges the lane branch into the run worktree without a commit, runs the gates on
  that tree, and commits only when they pass. A conflict or a failed gate aborts the merge, so the integration
  branch only ever holds merges whose gates passed. The coordinator gets the conflicted files, or the diff and the
  log tail, and sends the lane back with `revise_lane`, which starts a new pipeline run in the same lane workspace.
  ADR 0158 makes that run a short fix pass with the lane's own worker.
- **Never the base.** The provider's merge refuses any copy whose current branch is not `run/...` (R9.3).
- **Blocked lanes and status.** A lane whose pipeline blocks (a stage job waits with an error) tells the current
  coordinator once per new error, with the fix and Retry. The read-only `run_status` tool is on the coordinator's
  allowlist, so it can see each lane's stage, round, and `blocked` text instead of guessing.

## Consequences

- ADR 0151 adds cancel and the coordinator handover, and replaces opening the PR from the PR tab with a `run-pr`
  approval.
- One workspace per run. The main checkout is untouched.
- A lane merge can take as long as its gates. Merges of one run go one at a time.
- A wave starts only from merges whose gates passed.
