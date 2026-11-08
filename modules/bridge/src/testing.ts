import type { AgentEvent } from "@pi-spore/mod-agents/server";
import type { TestServer } from "@pi-spore/server-core/testing";
import type { ChatState } from "@pi-spore/shared";

/** Shared helpers of the bridge module's tests. */

export async function json<T = Record<string, unknown>>(
  response: Response,
  status = 200,
): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Calls a bridge route as an agent process would, with its own token. */
export function asAgent(server: TestServer, agentId: string, workspaceId: string) {
  const token = server.agentTokens.issue({ agentId, workspaceId });
  return (method: string, path: string, body?: unknown) =>
    server.request(method, `/api/bridge/${path}`, body, {
      "x-pi-spore-token": "",
      authorization: `Bearer ${token}`,
    });
}

export async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The messages of an agent's chat, as `role: text`. */
export async function chat(server: TestServer, agentId: string): Promise<string[]> {
  const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return (snapshot.chat as ChatState).messages.map((message) =>
    typeof message.content === "string"
      ? `${message.role}: ${message.content}`
      : `${message.role}: ${(message.content as { text?: string }[]).map((block) => block.text).join("")}`,
  );
}
