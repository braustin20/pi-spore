import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type {
  Approval,
  BridgeStartCardRequest,
  Card,
  CardAuthor,
  CardColumn,
  CreateCardRequest,
  UpdateCardRequest,
} from "@pi-spore/shared";

/**
 * Cards for other modules. `workChanged` is the seam for automatic moves (ADR 0012): the pipelines module calls it
 * with `review` when a pipeline passes, the PR module with `review` when a PR opens and `done` when it merges.
 */
export interface Cards {
  /** The cards started from this workspace. */
  forWorkspace(workspaceId: string): Card[];
  /**
   * Moves every card started from this workspace to `column`, unless it is there already, and records `reason` in
   * its history. A manual move stays until the next call.
   */
  workChanged(workspaceId: string, column: CardColumn, reason: string): void;
  /** Cards in board order, as `GET /api/kanban/cards` lists them. */
  list(filter: { projectId?: string; label?: string; column?: CardColumn }): Card[];
  /** Throws a 404 ApiError for an unknown card. */
  get(id: string): Card;
  /** Adds a card as `POST /api/kanban/cards` does, made by `by` (ADR 0100). */
  create(request: CreateCardRequest, by: CardAuthor): Promise<Card>;
  /** Changes a card as `PATCH` does, and moves it to `column` if given, as changed by `by`. */
  update(
    id: string,
    request: UpdateCardRequest & { column?: CardColumn },
    by: CardAuthor,
  ): Promise<Card>;
  /**
   * Files a `card-start` approval on Home for the calling agent (ADR 0100). Checks the card and target first: the
   * card must be in the agent's project, and an existing target must be an active workspace of that project.
   */
  requestStart(caller: BridgeCaller, cardId: string, request: BridgeStartCardRequest): Approval;
}

export const CardsKey = defineInterface<Cards>("kanban", "cards");
