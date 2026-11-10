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

const idle: Agent = {
  id: "a1",
  workspaceId: "w1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status: "idle",
  title: "Main work",
  createdAt: 0,
};

const busy: Agent = { ...idle, status: "busy" };

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

async function render({ phone, agent }: { phone: boolean; agent: Agent }) {
  screen(phone);
  const Pane = mainPane();
  const api = {
    get: async () => ({ agents: [agent] }),
    send: async () => ({}),
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "snapshot", agent });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Pane workspace={workspace} chatId={agent.id} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
const labelled = (name: string) => document.querySelector<HTMLElement>(`[aria-label="${name}"]`);

/** The composer's button row: the element that holds "Add images". */
function row() {
  const add = button("Add images");
  if (!add?.parentElement) throw new Error("no Add images button");
  return add.parentElement;
}

describe("the composer on a phone", () => {
  it("puts the busy controls in the one button row and leaves out the model and thinking", async () => {
    await render({ phone: true, agent: busy });
    const select = labelled("When a message sent now goes in");
    const stop = button("Stop");
    const queue = button("Queue");
    expect(select).not.toBeNull();
    expect(stop).toBeDefined();
    expect(queue).toBeDefined();
    for (const control of [select, stop, queue]) expect(row().contains(control as Node)).toBe(true);
    // Stop shows as an icon only; its text stays for screen readers.
    expect(stop?.querySelector("span")?.classList).toContain("max-md:sr-only");
    expect(labelled("Model for the next message")).toBeNull();
    expect(labelled("Thinking level")).toBeNull();
  });

  it("keeps thinking and Send in the button row while idle", async () => {
    await render({ phone: true, agent: idle });
    expect(row().contains(labelled("Thinking level"))).toBe(true);
    expect(row().contains(button("Send") as Node)).toBe(true);
    expect(labelled("When a message sent now goes in")).toBeNull();
  });
});

describe("the composer on a wide screen", () => {
  it("still shows the model and thinking controls while busy", async () => {
    await render({ phone: false, agent: busy });
    expect(labelled("When a message sent now goes in")).not.toBeNull();
    expect(button("Stop")).toBeDefined();
    expect(labelled("Model for the next message")).not.toBeNull();
    expect(labelled("Thinking level")).not.toBeNull();
  });
});
