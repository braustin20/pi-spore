# 0173. Explore also sends visual pipeline worker tasks local

- Status: Accepted; changes [0144](0144-routing-calibration.md) for the explore rule
- Date: 2026-11-11
- Requirements: R4.2, R4.3, R4.7, R4.10

## Context

ADR 0144 lets `router.explore` send a pipeline worker task local when "straightforward" is its only blocker. It
never sends a visual task. The user set `router.explore` to 1 to lean on the local worker, because every pipeline
slice is checked by a stronger reviewer and the check and test gates.

In the user's `routing.jsonl`, 35 pipeline worker tasks had the brief's full text. With explore at 1, 12 of them
went local. Jev's "visual" answer sent 18 of them to rung 3 (Opus): 6 alone, all small UI fixes, and 12 with
"straightforward". The local target is now a Q4 Strata model on a server that is always on, with a 262144-token
context and image input. The same reviewers and gates check a slice whether it ran local or in the cloud.

## Decision

- Explore applies when exactly one Jev question failed and it is "straightforward" or "visual", the estimate is
  not over `router.large`, and the local target can take the task. Then the task goes local on rung 1, with
  `explore: true` in the record.
- A task that fails both is a hard visual task, such as a greybox building, a particle effect, or a new
  animation. It stays on rung 3. In the user's log, "straightforward" was the answer that told these apart from
  small UI fixes: "design" and "foundational" passed for the new logo animation, "straightforward" was 0.36.
- "visual" counts as failed below `router.heavyThreshold`, as before. "straightforward" counts as failed below the
  rung-1 bar, as before.
- Everything else from ADR 0144 stays: only a pipeline worker stage explores, and a design or foundational task, a
  failed "bounded" or "explicit", a classifier error, a task over the local budget, a busy queue, or no local target
  never goes local through explore.
- Plain chats keep the visual rule. A visual chat task still goes to rung 3.

## Consequences

- More pipeline slices run local, so fewer use the Claude plan.
- A visual slice that fails locally escalates to rung 2, not rung 3. Its reviewers still run at their own tier.
- The calibration report (ADR 0144) now counts visual explore runs as local outcomes too.
