# 0100. Agents make and start cards; starts by an agent need an approval on Home

- Status: Accepted
- Date: 2026-11-07
- Requirements: R3.4, R11.4, R11.5, R15.1

## Context

The user plans work with an agent, often as a plan with phases, and wants the agent to turn it into kanban cards.
Cards can then be started by the user or by an agent. Work from a card starts in a new workspace, or in an existing
workspace when the work is related. An agent must not start work by itself: the user approves it on Home.

The domain model already lists an Approval entity (a decision gate on Home), planned for model upgrades (R3.4,
R4.8) and for closing a Unity editor (R10.6). None was built.

Starting in an existing workspace raises two questions the user answered:

- The workspace's worker may be busy. ADR 0030 already refuses a new worker chat while the worker is busy.
- The workspace may be parked. The board only offers active workspaces, and the workspaces contract cannot resume
  one.

## Decision

- **Card tools.** spore-bridge gets `kanban_list_cards`, `kanban_add_card`, `kanban_update_card`, and
  `kanban_start_card`. They reach only cards of the calling agent's project; a card of another project, or with no
  project, looks like it does not exist. Read-only side chats get none of them, and the bridge routes refuse a
  read-only token. A card remembers the agent (chat) that created it and the one that changed it last; a change by
  the user clears the second.
- **Start a card**, from the board, the CLI, or an approval, in one of two targets:
  - a new workspace, as before;
  - an active workspace of the card's project. The card links to it. A parked workspace is refused with 409
    `workspace_not_active`; the user resumes it first.
  In both cases the card's brief (title, labels, blockers, notes) goes to the workspace's active worker chat through
  `AgentsKey.deliver`, created first if the workspace has none. A busy worker gets it as a follow-up after its
  current run. The card moves to In progress (ADR 0040).
- **Approvals** live in the attention module (`attention_approvals`) and show on Home. An approval names its kind,
  the agent that asked, a title, the reason, a subject (JSON, checked by the kind's schema), and its state (`open`,
  `approved`, `declined`). The module that owns a gate registers its kind through `ApprovalsKey` with the subject
  schema and an `approve` step. Approve may carry a changed subject, which the kind's schema checks again. The
  outcome, or the decline with the user's note, goes back to the asking agent as a delivery, in the same
  transaction as the state change.
- `kanban_start_card` files a `card-start` approval and ends the turn, as `request_human_input` does. Home shows the
  card, whether it is blocked, the target, and the reason. The user can approve, change the target, or decline.
- Only the user's token reaches the approval routes. No bridge route decides an approval, so an agent cannot approve
  its own request.

## Consequences

- Model upgrades and "close Unity?" can reuse approvals: they register a kind and file approvals.
- Approvals always come from an agent, which gets the outcome. A gate with no agent behind it needs a change to the
  inbox item.
- Every start from a card sends a message to an agent, so starting a card starts work, from the board too.
- The live-agent limit (ADR 0026) still applies: a delivery to a stopped agent waits for a free slot.
- If the server stops while an approved start runs, the approval stays open. Approving again finds the card linked
  and is refused with 409 `card_has_workspace`; the user declines it.
