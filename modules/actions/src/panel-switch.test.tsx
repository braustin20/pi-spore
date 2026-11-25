// @vitest-environment happy-dom
import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { actionsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "Game",
  slug: "game",
  path: "/tmp/game",
  vcs: "git",
  traits: [],
  createdAt: 0,
};

const workspace = (id: string): Workspace => ({
  id,
  projectId: "p1",
  name: `Work ${id}`,
  slug: id,
  isolation: "new",
  planner: false,
  path: `/tmp/${id}`,
  state: "active",
  createdAt: 0,
  updatedAt: 0,
});

const list = (name: string) => ({
  actions: [{ name, run: name, shell: false, exclusive: false, source: "default" }],
});

/** Wires the real workspaces page to the real actions module, as the app does. */
function workspacePage() {
  const pages: WebPage[] = [];
  let view: unknown;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  actionsWeb.setup({ use: () => view } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId");
  if (!page) throw new Error("the workspaces module did not add its page");
  return page.component;
}

const Page = workspacePage();

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

/** w1's action list answers at once; w2's waits for the test. */
async function render() {
  let answerW2: (body: unknown) => void = () => {};
  const w2 = new Promise<unknown>((resolve) => {
    answerW2 = resolve;
  });
  const api = {
    get: async (path: string) => {
      if (path === "actions/workspaces/w1") return list("build");
      if (path === "actions/workspaces/w2") return w2;
      if (path.startsWith("actions/workspaces/")) return { runs: [] };
      if (path === "projects/settings") return { settings: [] };
      return { projects: [project] };
    },
    send: async () => ({}),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === "workspaces:list") {
        onEvent({ type: "snapshot", workspaces: [workspace("w1"), workspace("w2")] });
      }
      return () => {};
    },
  } as unknown as ApiClient;
  localStorage.setItem("pi-spore.workspaces.details", "1");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const show = (workspaceId: string) =>
    act(async () => {
      root?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Page params={{ workspaceId }} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
  await show("w1");
  const page = container;
  const runButtons = () =>
    [...page.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Run "));
  const text = () => page.textContent ?? "";
  return { show, runButtons, text, answerW2: (body: unknown) => act(async () => answerW2(body)) };
}

describe("the Actions panel when the workspace changes", () => {
  it("shows no Run button of the old workspace until the new list answers", async () => {
    const { show, runButtons, answerW2 } = await render();
    expect(runButtons()).toEqual(["Run build"]);

    await show("w2");
    expect(runButtons()).toEqual([]);

    await answerW2(list("test"));
    expect(runButtons()).toEqual(["Run test"]);
  });

  it("drops the loading spinner once the list and the runs have answered", async () => {
    const { show, text, answerW2 } = await render();
    expect(text()).not.toContain("Loading workspace");
    await show("w2");
    expect(text()).toContain("Loading workspace");
    await answerW2(list("test"));
    expect(text()).not.toContain("Loading workspace");
  });
});
