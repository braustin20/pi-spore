import type { Context } from "hono";
import { ApiError } from "./errors.js";

/** The agent process a spore-bridge request comes from, known from its agent token (architecture 2). */
export interface BridgeCaller {
  agentId: string;
  workspaceId: string;
}

/**
 * Tokens for agent processes. Each process gets its own; it is valid only on bridge routes (`/api/bridge/`) and
 * names that process's agent and workspace. The user's token never reaches an agent.
 */
export interface AgentTokens {
  issue(caller: BridgeCaller): string;
  /** Ends a token, for example when its process exits. */
  revoke(token: string): void;
}

/** The context key the server sets on bridge requests. */
export const BRIDGE_CALLER = "bridgeCaller";

/** The agent behind a bridge request. Throws a 401 outside bridge routes, where no agent token was checked. */
export function bridgeCaller(c: Context): BridgeCaller {
  const caller = c.get(BRIDGE_CALLER as never) as BridgeCaller | undefined;
  if (!caller) throw new ApiError(401, "unauthorized", "This route needs an agent token");
  return caller;
}
