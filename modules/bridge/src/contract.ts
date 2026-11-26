import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type {
  Approval,
  AskHermesRequest,
  HermesHandoff,
  HermesHandoffState,
  OpenWorkspacePrRequest,
  ReplyHermesRequest,
} from "@pi-spore/shared";

/**
 * Handoffs from Pi chats to Hermes (ADR 0202, card Hermes 1.2). The bridge refuses read-only side chats and lane
 * chats first; the hermes module refuses stage chats, a chat that works on a Hermes request (the hop rule), and a
 * Hermes that is off or set up wrong. A chat reaches only its own handoffs.
 */
export interface HermesAsker {
  /** Stores a `pending` handoff and starts its job. The same `receipt` from the same agent returns the first one. */
  ask(caller: BridgeCaller, request: AskHermesRequest, receipt: string): Promise<HermesHandoff>;
  /** Stops the handoff's run. Steps Hermes already did are not undone. */
  cancel(caller: BridgeCaller, id: string): Promise<HermesHandoff>;
  /**
   * Stores the result of a request from Hermes (card Hermes 1.3), which Hermes reads with `get_request`. Only the chat
   * the user gave the request to may reply, once, while it works on it.
   */
  reply(
    caller: BridgeCaller,
    request: ReplyHermesRequest,
  ): Promise<{ requestId: string; state: HermesHandoffState }>;
}

/** What other modules set on the bridge. */
export interface Bridge {
  /**
   * Sets how `POST /api/bridge/workspace/pr` files a `workspace-pr` approval. The github-pr module sets it, so the
   * bridge does not depend on it. At most one requester; without one the route answers 422 `not_supported`.
   */
  setPrRequester(
    request: (caller: BridgeCaller, request: OpenWorkspacePrRequest) => Promise<Approval>,
  ): void;
  /**
   * Sets who answers `POST /api/bridge/hermes/asks`, its cancel, and `POST /api/bridge/hermes/replies`. The hermes module sets it, so the bridge does not
   * depend on it, and a disabled hermes module leaves the routes at 422 `not_supported`. At most one asker.
   */
  setHermesAsker(asker: HermesAsker): void;
}

export const BridgeKey = defineInterface<Bridge>("bridge", "bridge");
