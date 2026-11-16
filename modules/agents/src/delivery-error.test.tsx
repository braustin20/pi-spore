// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { agentsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_KEY = "No API key found for anthropic.";

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "Work",
  slug: "work",
  isolation: "new",
  planner: false,
  path: "/tmp/work",
  state: "active",
  createdAt: 0,
  updatedAt: 0,
};

const stage = (deliveryError?: string): Agent => ({
  id: "a1",
  workspaceId: "w1",
  role: "worker",
  kind: "stage",
  active: true,
  title: "implement",
  status: "idle",
  statusSince: 0,
  ...(deliveryError ? { deliveryError } : {}),
  createdAt: 0,
});

function mainPane() {
  let main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
  const view = {
    setMain: (pane: typeof main) => (main = pane),
    setStatus: () => {},
    addSection: () => {},
  };
  agentsWeb.setup({
    provide: () => {},
    use: () => view,
  } as unknown as WebHost);
  if (!main) throw new Error("the agents module did not set a main pane");
  return main;
}

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function scrollerText(agent: Agent) {
  const Pane = mainPane();
  const api = {
    get: async () => ({ agents: [agent] }),
    send: async () => ({}),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === `agent:${agent.id}`) onEvent({ type: "snapshot", agent });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Pane workspace={workspace} chatId={agent.id} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const scroller = container.querySelector(".overflow-y-auto");
  if (!scroller) throw new Error("the chat did not render");
  return scroller.textContent ?? "";
}

describe("a message that did not reach the agent", () => {
  it("shows its error in place of the empty chat", async () => {
    const text = await scrollerText(stage(NO_KEY));
    expect(text).toContain(NO_KEY);
    expect(text).not.toContain("No messages yet");
  });

  it("shows the empty chat when no message failed", async () => {
    const text = await scrollerText(stage());
    expect(text).toContain("No messages yet");
    expect(text).not.toContain(NO_KEY);
  });
});
