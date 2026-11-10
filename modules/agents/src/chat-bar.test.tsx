// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ChatBar } from "./chats.js";
import { agentsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: string, status: Agent["status"]): Agent => ({
  id,
  workspaceId: "w1",
  role: "orchestrator",
  kind: "side",
  active: false,
  status,
  title: id,
  createdAt: 0,
});

let container: HTMLElement | undefined;
let reactRoot: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => reactRoot?.unmount());
  container?.remove();
});

const tab = (id: string) =>
  container?.querySelector(`a[href="#/workspaces/w1/chats/${id}"]`)?.textContent;

async function renderBar(
  canStart: boolean,
  onNew: (kind: "worker" | "side", fork: boolean) => void,
) {
  const main = { ...chat("main", "idle"), kind: "worker" as const, active: true };
  container = document.body.appendChild(document.createElement("div"));
  reactRoot = createRoot(container);
  await act(async () =>
    reactRoot?.render(
      <TooltipProvider>
        <ChatBar
          workspaceId="w1"
          chats={[main]}
          selected={main}
          canStart={canStart}
          onNew={onNew}
          onRename={async () => {}}
          onClose={() => {}}
        />
      </TooltipProvider>,
    ),
  );
}

const buttons = () => [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
const plus = () => buttons().find((b) => b.getAttribute("aria-label") === "New chat or side chat");

/** Radix menus open on a primary-button pointerdown, not on click. */
async function openMenu(trigger: HTMLElement | undefined) {
  if (!trigger) throw new Error("no menu trigger");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  const menu = document.querySelector<HTMLElement>("[role=menu]");
  if (!menu) throw new Error("the menu did not open");
  return menu;
}

describe("ChatBar", () => {
  it("marks the tab of a working chat as working", async () => {
    const busy = chat("busy", "busy");
    const idle = chat("idle", "idle");
    container = document.body.appendChild(document.createElement("div"));
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        <TooltipProvider>
          <ChatBar
            workspaceId="w1"
            chats={[busy, idle]}
            selected={idle}
            canStart
            onNew={() => {}}
            onRename={async () => {}}
            onClose={() => {}}
          />
        </TooltipProvider>,
      ),
    );
    expect(tab("busy")).toContain("working");
    expect(tab("idle")).not.toContain("working");
  });

  it("starts new chats from one + menu", async () => {
    const calls: [string, boolean][] = [];
    await renderBar(true, (kind, fork) => calls.push([kind, fork]));
    expect(
      buttons().filter((b) => b.getAttribute("aria-label") === "New chat or side chat"),
    ).toHaveLength(1);
    const texts = buttons().map((b) => b.textContent?.trim());
    for (const text of ["New chat", "Side chat", "Side chat with context"]) {
      expect(texts).not.toContain(text);
    }
    for (const name of [/^New chat/, /^Side chat(?! with)/, /^Side chat with context/]) {
      const menu = await openMenu(plus());
      const item = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")].find((el) =>
        name.test(el.textContent ?? ""),
      );
      if (!item) throw new Error(`no menu item ${String(name)}`);
      await act(async () => item.click());
    }
    expect(calls).toEqual([
      ["worker", false],
      ["side", false],
      ["side", true],
    ]);
  });

  it("disables the + menu when no chat can start", async () => {
    await renderBar(false, () => {});
    expect(plus()?.disabled).toBe(true);
  });
});

describe("the chat pane's tabs", () => {
  const workspace: Workspace = {
    id: "w1",
    projectId: "p1",
    name: "Work",
    slug: "work",
    isolation: "new",
    path: "/tmp/work",
    state: "active",
    createdAt: 0,
    updatedAt: 0,
  };

  function mainPane() {
    let main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
    const view = { setMain: (pane: typeof main) => (main = pane), setStatus: () => {} };
    agentsWeb.setup({ provide: () => {}, use: () => view } as unknown as WebHost);
    if (!main) throw new Error("the agents module did not set a main pane");
    return main;
  }

  it("follow live status changes from agents:list and keep their order", async () => {
    const worker: Agent = { ...chat("worker", "idle"), kind: "worker", active: true };
    const side = chat("side", "idle");
    const listeners = new Map<string, (event: unknown) => void>();
    const api = {
      get: async () => ({ agents: [worker, side] }),
      send: async () => ({}),
      subscribe: (topic: string, onEvent: (event: unknown) => void) => {
        listeners.set(topic, onEvent);
        if (topic === "agent:worker") onEvent({ type: "snapshot", agent: worker });
        return () => listeners.delete(topic);
      },
    } as unknown as ApiClient;
    const Pane = mainPane();
    container = document.body.appendChild(document.createElement("div"));
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Pane workspace={workspace} chatId="worker" />
          </TooltipProvider>
        </ApiContext>,
      ),
    );
    expect(tab("side")).not.toContain("working");

    const list = (event: unknown) => act(async () => listeners.get("agents:list")?.(event));
    await list({ type: "agent", agent: { ...side, status: "busy" } });
    expect(tab("side")).toContain("working");
    const order = () =>
      [...(container?.querySelectorAll('nav[aria-label="Chats"] a') ?? [])].map((a) =>
        a.getAttribute("href"),
      );
    expect(order()).toEqual(["#/workspaces/w1/chats/worker", "#/workspaces/w1/chats/side"]);

    await list({ type: "agent", agent: { ...side, status: "idle" } });
    expect(tab("side")).not.toContain("working");
  });
});
