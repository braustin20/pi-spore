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

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** w1's list and runs answer at once; w2's wait for the test. */
async function render() {
  const w2List = deferred<unknown>();
  const w2Runs = deferred<unknown>();
  const api = {
    get: async (path: string) => {
      if (path === "actions/workspaces/w1") return list("build");
      if (path === "actions/workspaces/w1/runs") return { runs: [] };
      if (path === "actions/workspaces/w2") return w2List.promise;
      if (path === "actions/workspaces/w2/runs") return w2Runs.promise;
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
  const loading = () => (page.textContent ?? "").includes("Loading workspace");
  const settle = (work: () => void) => act(async () => work());
  return { show, runButtons, loading, settle, w2List, w2Runs };
}

describe("the Actions panel when the workspace changes", () => {
  it("shows no Run button of the old workspace until the new list answers", async () => {
    const { show, runButtons, settle, w2List } = await render();
    expect(runButtons()).toEqual(["Run build"]);

    await show("w2");
    expect(runButtons()).toEqual([]);

    await settle(() => w2List.resolve(list("test")));
    expect(runButtons()).toEqual(["Run test"]);
  });
});

describe("the Details spinner while the Actions panel loads", () => {
  it("is gone only when the list and the runs have both answered", async () => {
    const { show, loading, settle, w2List, w2Runs } = await render();
    expect(loading()).toBe(false);

    await show("w2");
    expect(loading()).toBe(true);
    await settle(() => w2List.resolve(list("test")));
    expect(loading()).toBe(true);
    await settle(() => w2Runs.resolve({ runs: [] }));
    expect(loading()).toBe(false);
  });

  it("is gone when the runs answered first and the list answers last", async () => {
    const { show, loading, settle, w2List, w2Runs } = await render();
    await show("w2");
    await settle(() => w2Runs.resolve({ runs: [] }));
    expect(loading()).toBe(true);
    await settle(() => w2List.resolve(list("test")));
    expect(loading()).toBe(false);
  });

  it("is gone when the list fails and the runs answer", async () => {
    const { show, loading, settle, w2List, w2Runs } = await render();
    await show("w2");
    await settle(() => w2Runs.resolve({ runs: [] }));
    expect(loading()).toBe(true);
    await settle(() => w2List.reject(new Error("no config")));
    expect(loading()).toBe(false);
  });

  it("is gone when the runs fail and the list answers", async () => {
    const { show, loading, settle, w2List, w2Runs } = await render();
    await show("w2");
    await settle(() => w2List.resolve(list("test")));
    expect(loading()).toBe(true);
    await settle(() => w2Runs.reject(new Error("no runs")));
    expect(loading()).toBe(false);
  });
});
