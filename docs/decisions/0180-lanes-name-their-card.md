# 0180. A lane names its card, and pi-spore moves the card with the run

- Status: Accepted
- Date: 2026-11-15
- Requirements: R7, R11
- Builds on: [ADR 0012](0012-kanban.md), [ADR 0154](0154-coordinator-adds-cards.md),
  [ADR 0100](0100-agent-cards-and-approvals.md), [ADR 0003](0003-modules.md)

## Context

A run started from a plan card moves only that card (`run-started`). The coordinator then starts lanes for the
plan's other cards. A lane has no link to a card, so those cards stay in Ready or Backlog. ADR 0154 forbids the
coordinator to change cards, so it cannot move them either. The user decided on 2026-11-15: lanes name their card,
and pi-spore moves it.

## Decision

1. **`start_lane` takes an optional `cardId`**: the id of the card the lane does, from `kanban_list_cards`. One card
   per lane at most. The runs module stores it in `runs_lanes.card_id` and shows it as `cardId` on the `Lane` view.
   `revise_lane` keeps the lane's card.
2. **Seam direction (ADR 0003).** Kanban requires runs, so runs must not require kanban. Kanban registers a card
   linker with `RunsKey.setCardLinker(link)`, as github-pr registers the PR opener with `setPrOpener`. At most one
   linker. `start_lane` with a `cardId` and no linker answers 422 `cards_not_supported`.
3. **One call checks and links, in the lane's transaction.** `startLane` calls the linker inside the transaction
   that stores the lane, before the insert. A refusal rolls the lane back, and the coordinator gets the error from
   `start_lane` at once. There is no second check and no listener that links later.
4. **What the linker refuses** (kanban, fail loudly):
   - a card that does not exist, has no project, or is in another project: 404 `card_not_found`, as ADR 0100 does;
   - a card in Done: 409 `card_done`;
   - a card linked to an open workspace other than the run workspace: 409 `card_has_workspace`, naming that
     workspace.
   The runs module refuses a card that another lane of the same run names: 409 `card_in_lane`, naming that lane.
   That check reads only the runs module's own table.
5. **The card links to the run workspace, not the lane workspace.** The linker sets the card's workspace to the run
   workspace and moves it to In progress with reason `lane-started`. The existing `CardsKey.workChanged` calls on
   the run workspace then move it to Review when the run's PR opens and to Done when the PR merges or the run
   workspace is archived. A link to the lane workspace would be wrong: the lane's own state changes would move the
   card before the run's PR exists. A card already linked to the run workspace (such as the card that started the
   run) stays linked; only its column changes, if it is not in progress.
6. **No move back.** A cancelled, failed, or declined lane leaves its card in In progress, linked to the run
   workspace. The user moves it.
7. **ADR 0154 stays true.** The coordinator never edits or starts a card. It names one; pi-spore moves it. The
   coordinator still gets 403 `run_coordinator` on a card change or start.
8. The coordinator rules say: when a lane does one card, pass its `cardId`.

## Consequences

- The plan's cards follow the run on the board without a coordinator card tool.
- A card can join a run only while it is not done and not taken by another open workspace.
- A wrong `cardId` is refused before the lane exists, so no lane starts on a bad link.
