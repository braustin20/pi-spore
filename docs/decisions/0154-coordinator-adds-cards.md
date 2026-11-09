# 0154. A run's coordinator adds follow-up cards, but never changes or starts them

- Status: Accepted
- Date: 2026-11-09
- Requirements: R7.1 to R7.6
- Changes: the coordinator tool list of [ADR 0150](0150-run-worktree-and-green-merges.md)

## Context

In the first real run, lanes found follow-up work out of the run's scope. The coordinator had no card tools, so it
wrote artifacts such as `cards/settings-followups.md`, and the user turned them into cards by hand.

## Decision

- The coordinator's allowlist gets `kanban_list_cards` and `kanban_add_card` (ADR 0100). It does not get
  `kanban_update_card` or `kanban_start_card`; spore-bridge does not register them for it. Starting work stays the
  user's call. Nothing else changes about what the coordinator can do.
- The bridge refuses a card change or start from an agent in a run workspace with 403 `run_coordinator`.
- A card an agent in a run workspace adds goes to `backlog` and gets the label `from-run:<slug of the run name>`
  (slug up to 31 characters, so the label fits in 40). The server sets both, so the model cannot forget them. No
  card schema change.
- The coordinator rules say: list cards first, add one card per follow-up item with the why, the steps, and how to
  check, never start a card. This replaces `cards/*.md` artifacts.
- Lane agents keep the card tools they have.

## Consequences

- The user sees where each follow-up card came from and decides when to start it.
- Two runs with the same name share a `from-run` label.
