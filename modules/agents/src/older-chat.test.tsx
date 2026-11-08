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

const OLDER_TEXT = "This is an older orchestrator chat";

const workspace = (state: Workspace["state"]): Workspace => ({
  id: "w1",
  projectId: "p1",
  name: "Work",
  slug: "work",
  isolation: "new",
  path: "/tmp/work",
  state,
  createdAt: 0,
  updatedAt: 0,
});

const chat = (active: boolean): Agent => ({
  id: "a1",
  workspaceId: "w1",
  role: "orchestrator",
  kind: "worker",
  active,
  status: "idle",
  createdAt: 0,
});

function mainPane() {
  let main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
  const view = { setMain: (pane: typeof main) => (main = pane), setStatus: () => {} };
  agentsWeb.setup({
    provide: () => {},
    use: () => view,
  } as unknown as WebHost);
  if (!main) throw new Error("the agents module did not set a main pane");
  return main;
}

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function render(agent: Agent, state: Workspace["state"]) {
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
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Pane workspace={workspace(state)} chatId={agent.id} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const section = container.querySelector("section");
  const scroller = container.querySelector(".overflow-y-auto");
  if (!section || !scroller) throw new Error("the chat did not render");
  return { section, scroller, strip: section.lastElementChild as HTMLElement };
}

describe("older worker chat notice", () => {
  it("sits in the composer strip, not the message scroller, with Make active first", async () => {
    const { scroller, strip } = await render(chat(false), "active");
    expect(scroller.textContent).not.toContain(OLDER_TEXT);
    expect(strip.textContent).toContain(OLDER_TEXT);
    const first = strip.querySelector("button, textarea, input, select, [tabindex]");
    expect(first?.textContent).toBe("Make active");
    expect((first as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Make active while the workspace is not active", async () => {
    const { strip } = await render(chat(false), "parked");
    expect((strip.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no notice for the active chat", async () => {
    const { section } = await render(chat(true), "active");
    expect(section.textContent).not.toContain(OLDER_TEXT);
    expect(section.textContent).not.toContain("Make active");
  });
});
