import { createHash, randomBytes } from "node:crypto";
import type { AgentTokens, BridgeCaller } from "@pi-spore/module-api";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Agent tokens live in memory: agent processes end with the server, so no token needs to outlive it. Tokens are
 * looked up by their hash, so the lookup time says nothing about a guessed token.
 */
export class AgentTokenStore implements AgentTokens {
  private readonly byHash = new Map<string, BridgeCaller>();

  issue(caller: BridgeCaller): string {
    const token = randomBytes(32).toString("hex");
    this.byHash.set(hash(token), {
      agentId: caller.agentId,
      workspaceId: caller.workspaceId,
      ...(caller.readOnly ? { readOnly: true } : {}),
    });
    return token;
  }

  revoke(token: string): void {
    this.byHash.delete(hash(token));
  }

  find(token: string | undefined): BridgeCaller | undefined {
    return token ? this.byHash.get(hash(token)) : undefined;
  }
}
