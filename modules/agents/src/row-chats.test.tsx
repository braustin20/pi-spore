// @vitest-environment happy-dom

import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Agent, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { agentsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = (id: string): Workspace => ({
  id,
  projectId: "p1",
  name: `Work ${id}`,
  slug: id,
  isolation: "new",
  planner: false,
  path: `/tmp/${id}`,
  line: `spore/${id}`,
  state: "active",
  createdAt: 0,
  updatedAt: 0,
});

const chat = (id: string, workspaceId: string, extra: Partial<Agent>): Agent => ({
  id,
  workspaceId,
  role: "orchestrator",
  kind: "worker",
  active: false,
  status: "idle",
  title: `Chat ${id}`,
  createdAt: 0,
  ...extra,
});

const AGENTS = [
  chat("old", "w1", { kind: "worker", active: false, createdAt: 1 }),
  chat("main", "w1", { kind: "worker", active: true, createdAt: 2 }),
  chat("side", "w1", { kind: "side", status: "busy", createdAt: 3 }),
  chat("lone-old", "w2", { kind: "worker", active: false }),
];

/** Wires the real workspaces page to the real agents module, as the app does. */
function listPage() {
  const pages: WebPage[] = [];
  let view: unknown;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  agentsWeb.setup({ provide: () => {}, use: () => view } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId/chats/:chatId");
  if (!page) throw new Error("the workspaces module did not add its chat page");
  return page.component;
}

const Page = listPage();

let container: HTMLElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

async function render(params: Record<string, string>) {
  const api = {
    get: async (path: string) =>
      path.startsWith("agents")
        ? { agents: AGENTS.filter((agent) => agent.workspaceId === "w1") }
        : { projects: [] },
    send: async () => ({ agent: AGENTS[1] }),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === "workspaces:list") {
        onEvent({ type: "snapshot", workspaces: [workspace("w1"), workspace("w2")] });
      }
      if (topic === "agents:list") onEvent({ type: "snapshot", agents: AGENTS });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={params} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const list = container.querySelector('aside[aria-label="Workspaces"]');
  if (!list) throw new Error("the list did not render");
  return list;
}

const toggle = (list: Element, name: string) =>
  list.querySelector<HTMLButtonElement>(`button[aria-label="Show chats of ${name}"]`) ??
  list.querySelector<HTMLButtonElement>(`button[aria-label="Hide chats of ${name}"]`);
const chatLink = (list: Element, id: string) =>
  list.querySelector<HTMLAnchorElement>(`a[href="#/workspaces/w1/chats/${id}"]`);

describe("a workspace row's chats", () => {
  it("start hidden, and the toggle shows the open chats but not older ones", async () => {
    const list = await render({});
    const button = toggle(list, "Work w1");
    if (!button) throw new Error("no chats toggle on Work w1");
    expect(button.closest("a")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(chatLink(list, "main")).toBeNull();
    expect(chatLink(list, "side")).toBeNull();

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Hide chats of Work w1");
    expect(chatLink(list, "main")?.textContent).toContain("Chat main");
    expect(chatLink(list, "main")?.textContent).not.toContain("working");
    expect(chatLink(list, "side")?.textContent).toContain("working");
    expect(chatLink(list, "old")).toBeNull();
    expect(localStorage.length).toBe(1);

    await act(async () => button.click());
    expect(chatLink(list, "main")).toBeNull();
  });

  it("has no toggle when the workspace has only older chats", async () => {
    const list = await render({});
    expect(toggle(list, "Work w2")).toBeNull();
  });

  it("stays open across a reload and marks the current chat", async () => {
    const first = await render({});
    await act(async () => toggle(first, "Work w1")?.click());
    act(() => root?.unmount());
    container?.remove();

    const list = await render({ workspaceId: "w1", chatId: "side" });
    expect(toggle(list, "Work w1")?.getAttribute("aria-expanded")).toBe("true");
    expect(chatLink(list, "side")?.getAttribute("aria-current")).toBe("page");
    expect(chatLink(list, "main")?.getAttribute("aria-current")).toBeNull();
  });
});
