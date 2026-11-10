// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, Workspace } from "@pi-spore/shared";
import { PHONE_QUERY, TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const worker: Agent = {
  id: "a1",
  workspaceId: "w1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status: "idle",
  title: "Main work",
  createdAt: 0,
};

const side: Agent = { ...worker, id: "a2", kind: "side", title: "Look around" };

function mainPane() {
  let main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
  const view = { setMain: (pane: typeof main) => (main = pane), setStatus: () => {} };
  agentsWeb.setup({ provide: () => {}, use: () => view } as unknown as WebHost);
  if (!main) throw new Error("the agents module did not set a main pane");
  return main;
}

function screen(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY && phone,
    addEventListener() {},
    removeEventListener() {},
  }));
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function render({ phone, agent = worker }: { phone: boolean; agent?: Agent }) {
  screen(phone);
  const Pane = mainPane();
  const sent: { path: string; body: unknown }[] = [];
  const api = {
    get: async () => ({ agents: [worker, side] }),
    send: async (_method: string, path: string, body?: unknown) => {
      sent.push({ path, body });
      return path === "agents/chats" ? { agent: { id: "a3" } } : {};
    },
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({
        type: "snapshot",
        agent,
        contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 },
      });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Pane workspace={workspace} chatId={worker.id} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  return sent;
}

const byName = (name: string | RegExp, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLElement>("button, a, [role=menuitem]")].find((element) => {
    const text = element.getAttribute("aria-label") ?? element.textContent ?? "";
    return typeof name === "string" ? text === name : name.test(text);
  });

/** Radix menus open on a primary-button pointerdown, not on click. */
async function open(trigger: HTMLElement | undefined) {
  if (!trigger) throw new Error("no menu trigger");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  const menu = document.querySelector<HTMLElement>("[role=menu]");
  if (!menu) throw new Error("the menu did not open");
  return menu;
}

async function choose(menu: HTMLElement, name: string | RegExp) {
  const item = byName(name, menu);
  if (!item) throw new Error(`no menu item ${String(name)}`);
  await act(async () => item.click());
}

describe("the chat row on a phone", () => {
  it("merges the header and the chat bar into one row", async () => {
    await render({ phone: true });
    const section = container?.querySelector("section") as HTMLElement;
    expect(section.querySelector("header")).toBeNull();
    expect(section.querySelector("nav[aria-label=Chats]")).toBeNull();
    expect(byName("Stop agent")).toBeUndefined();
    expect(byName("Chat actions")).toBeDefined();
    expect(byName("Chats: Main work")).toBeDefined();
    expect(section.textContent).toContain("idle");
  });

  it("runs each chat action from the menu", async () => {
    const sent = await render({ phone: true });
    const actions = async (name: string) => choose(await open(byName("Chat actions")), name);

    const menu = await open(byName("Chat actions"));
    expect(menu.textContent).toContain("context 42%");
    await choose(menu, "Compact");
    await actions("Stop agent");
    await actions("New chat");
    await actions("Side chat");
    await actions("With context");
    expect(sent.filter(({ path }) => path !== "agents")).toEqual([
      { path: "agents/a1/compact", body: undefined },
      { path: "agents/a1/stop", body: undefined },
      { path: "agents/chats", body: { workspaceId: "w1", kind: "worker" } },
      { path: "agents/chats", body: { workspaceId: "w1", kind: "side" } },
      { path: "agents/chats", body: { workspaceId: "w1", kind: "side", fork: true } },
    ]);
  });

  it("closes the chat from the menu after the confirm dialog", async () => {
    const sent = await render({ phone: true });
    await choose(await open(byName("Chat actions")), "Close this chat");
    const dialog = document.querySelector<HTMLElement>("[role=alertdialog]");
    expect(dialog?.textContent).toContain('Close "Main work"?');
    await act(async () => byName("Close chat", dialog as HTMLElement)?.click());
    expect(sent.map(({ path }) => path)).toContain("agents/a1/close");
  });

  it("turns the row into the title form on Rename", async () => {
    const sent = await render({ phone: true });
    await choose(await open(byName("Chat actions")), "Rename");
    const input = container?.querySelector<HTMLInputElement>("input[aria-label='Chat title']");
    expect(input?.value).toBe("Main work");
    expect(byName("Chat actions")).toBeUndefined();
    await act(async () => byName("Cancel")?.click());
    expect(byName("Chat actions")).toBeDefined();
    expect(sent.some(({ path }) => path.endsWith("/title"))).toBe(false);
  });

  it("lists every chat in the picker and links to each one", async () => {
    await render({ phone: true });
    const menu = await open(byName("Chats: Main work"));
    const links = [...menu.querySelectorAll<HTMLAnchorElement>("a[role=menuitem]")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#/workspaces/w1/chats/a1",
      "#/workspaces/w1/chats/a2",
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[1]?.getAttribute("aria-current")).toBeNull();
    expect(links[1]?.textContent).toContain("(side chat)");
    await act(async () => links[1]?.click());
    expect(window.location.hash).toBe("#/workspaces/w1/chats/a2");
  });
});

describe("a long state label on a phone", () => {
  it("truncates in a shrinkable slot, so the picker and Chat actions keep their room", async () => {
    const long = "Pipeline: review-all-module-boundaries-for-security-and-regressions";
    await render({ phone: true, agent: { ...worker, workingFor: long } });
    const chip = [...document.querySelectorAll("span")].find(
      (span) => span.textContent === `working (${long})`,
    );
    // happy-dom has no layout, so the test checks the flex rules that keep the row inside the screen.
    const slot = chip?.parentElement;
    expect(slot?.classList).toContain("min-w-0");
    expect(slot?.classList).toContain("flex-1");
    expect(byName("Chat actions")?.classList).toContain("shrink-0");
    expect(byName("Chats: Main work")?.classList).toContain("max-w-[60%]");
  });
});

describe("the chat header on a wide screen", () => {
  it("keeps the header with Stop agent and the Chats row", async () => {
    await render({ phone: false });
    const section = container?.querySelector("section") as HTMLElement;
    expect(section.querySelector("header")?.textContent).toContain("Work");
    expect(byName("Stop agent", section)).toBeDefined();
    expect(section.querySelector("nav[aria-label=Chats]")).not.toBeNull();
    expect(byName("Chat actions")).toBeUndefined();
  });

  it("makes the Chats row the containing block of its hidden tab labels", async () => {
    await render({ phone: false });
    // sr-only labels are position: absolute. Without a positioned row they escape its scroll clip and widen
    // the page. happy-dom has no layout, so the test checks the class.
    expect(document.querySelector("nav[aria-label=Chats]")?.classList).toContain("relative");
  });
});
