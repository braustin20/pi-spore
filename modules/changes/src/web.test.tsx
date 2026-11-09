// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, DiffComment, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { changesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: "W1" } as Workspace;

const comment: DiffComment = {
  id: "C1",
  workspaceId: "W1",
  path: "src/a.ts",
  side: "new",
  line: 3,
  code: "x",
  body: "Fix line 3.",
  createdAt: 0,
  staged: true,
};

const agent: Agent = {
  id: "A1",
  workspaceId: "W1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status: "waiting",
  createdAt: 0,
};

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

/**
 * Renders a component of the module against an API whose event socket never replays a snapshot, as for a second
 * subscriber to a topic (EventSocket sends the snapshot to the first listener only).
 */
async function renderPanel(
  pick: "chat" | "tab",
  loadComments: () => Promise<unknown> = async () => ({ comments: [comment] }),
) {
  const listeners: ((event: unknown) => void)[] = [];
  let chatPanel: ComponentType<{ chatId: string }> | undefined;
  let tab: ComponentType<{ workspace: Workspace }> | undefined;
  changesWeb.setup({
    use: (key: unknown) =>
      key === AgentsWebKey
        ? { addChatPanel: (_id: string, panel: typeof chatPanel) => (chatPanel = panel) }
        : key === WorkspaceViewKey
          ? { addTab: (added: { component: typeof tab }) => (tab = added.component) }
          : undefined,
  } as unknown as WebHost);
  const api = {
    get: async (path: string) => {
      if (path === "agents/A1") return { agent };
      if (path === "changes/workspaces/W1/comments") return loadComments();
      throw new Error(`unexpected GET ${path}`);
    },
    subscribe: (_topic: string, listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    const Component = (pick === "chat" ? chatPanel : tab) as
      | ComponentType<{ chatId: string; workspace: Workspace }>
      | undefined;
    if (!Component) throw new Error("the changes module did not add its component");
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Component chatId="A1" workspace={workspace} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  return {
    root: container,
    emit: (event: unknown) => act(async () => listeners.map((l) => l(event))),
  };
}

describe("comments as a second subscriber", () => {
  it("shows the staged batch above the composer without a new event", async () => {
    const { root } = await renderPanel("chat");
    expect(root.textContent).toContain("1 diff comment will go with your next message");
  });

  it("shows the comments bar of the Changes tab without a new event", async () => {
    const { root } = await renderPanel("tab");
    expect(root.textContent).toContain("1 comment for the agent");
  });

  it.each(["chat", "tab"] as const)(
    "keeps a newer event when the first load answers late (%s)",
    async (pick) => {
      let answer: (body: unknown) => void = () => {};
      const { root, emit } = await renderPanel(
        pick,
        () => new Promise((resolve) => (answer = resolve)),
      );
      await emit({ type: "comments", comments: [comment] });
      await act(async () => answer({ comments: [] }));
      expect(root.textContent).toContain(pick === "chat" ? "1 diff comment" : "1 comment for");
    },
  );

  it("shows a failed load as an error, not as an empty batch", async () => {
    const { root } = await renderPanel("chat", async () => {
      throw new Error("down");
    });
    expect(root.textContent).toContain("down");
    expect(root.textContent).not.toContain("0 diff comments");
  });
});
