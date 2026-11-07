import { defineInterface } from "@pi-spore/module-api";
import type { Card, CardColumn } from "@pi-spore/shared";

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
}

export const CardsKey = defineInterface<Cards>("kanban", "cards");
