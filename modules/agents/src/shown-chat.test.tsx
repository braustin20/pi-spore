// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { agentsWeb } from "./web.js";
import { type AgentsWeb, AgentsWebKey } from "./web-contract.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const chat = (id: string, active: boolean): Agent => ({
  id,
  workspaceId: "w1",
  role: "orchestrator",
  kind: "worker",
  active,
  status: "idle",
  createdAt: 0,
});

function setup() {
  let main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
  let web: AgentsWeb | undefined;
  const view = { setMain: (pane: typeof main) => (main = pane), setStatus: () => {} };
  agentsWeb.setup({
    provide: (key: unknown, impl: AgentsWeb) => {
      if (key === AgentsWebKey) web = impl;
    },
    use: () => view,
  } as unknown as WebHost);
  if (!main || !web) throw new Error("the agents module did not set up");
  return { Pane: main, web };
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(chatId?: string) {
  const { Pane, web } = setup();
  const show = (id?: string) =>
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Pane workspace={workspace} {...(id === undefined ? {} : { chatId: id })} />
        </TooltipProvider>
      </ApiContext>,
    );
  const agents = [chat("a1", true), chat("a2", false)];
  const api = {
    get: async () => ({ agents }),
    send: async () => ({}),
    subscribe: () => () => {},
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    show(chatId);
  });
  return { web, show };
}

describe("the chat on screen", () => {
  it("is the active chat when the route names no chat", async () => {
    const { web } = await render();
    expect(web.shownChat()).toBe("a1");
  });

  it("follows a switch to another chat", async () => {
    const { web, show } = await render();
    await act(async () => show("a2"));
    expect(web.shownChat()).toBe("a2");
  });

  it("is the chat the route names", async () => {
    const { web } = await render("a2");
    expect(web.shownChat()).toBe("a2");
  });

  it("is none after the chat pane leaves the page", async () => {
    const { web } = await render();
    await act(async () => root?.unmount());
    root = undefined;
    expect(web.shownChat()).toBeUndefined();
  });
});
