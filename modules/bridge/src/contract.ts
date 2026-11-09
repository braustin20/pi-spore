import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { Approval, OpenWorkspacePrRequest } from "@pi-spore/shared";

/** What other modules set on the bridge. */
export interface Bridge {
  /**
   * Sets how `POST /api/bridge/workspace/pr` files a `workspace-pr` approval. The github-pr module sets it, so the
   * bridge does not depend on it. At most one requester; without one the route answers 422 `not_supported`.
   */
  setPrRequester(
    request: (caller: BridgeCaller, request: OpenWorkspacePrRequest) => Promise<Approval>,
  ): void;
}

export const BridgeKey = defineInterface<Bridge>("bridge", "bridge");
