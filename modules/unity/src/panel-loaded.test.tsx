// @vitest-environment happy-dom
import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { unityWeb } from "./web.js";

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

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "Work w1",
  slug: "w1",
  isolation: "new",
  planner: false,
  path: "/tmp/w1",
  state: "active",
  createdAt: 0,
  updatedAt: 0,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wires the real workspaces page to the real unity module, as the app does. */
function workspacePage() {
  const pages: WebPage[] = [];
  let view: unknown;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  unityWeb.setup({
    use: () => ({ ...(view as object) }),
  } as unknown as WebHost);
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

/** w1's Unity view waits for the test. */
async function render() {
  const view = deferred<unknown>();
  const api = {
    get: async (path: string) => {
      if (path === "unity/workspaces/w1") return view.promise;
      return path === "projects/settings" ? { settings: [] } : { projects: [project] };
    },
    send: async () => ({}),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === "workspaces:list") onEvent({ type: "snapshot", workspaces: [workspace] });
      return () => {};
    },
  } as unknown as ApiClient;
  localStorage.setItem("pi-spore.workspaces.details", "1");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={{ workspaceId: "w1" }} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const page = container;
  return {
    loading: () => (page.textContent ?? "").includes("Loading workspace"),
    settle: (work: () => void) => act(async () => work()),
    view,
  };
}

describe("the Details spinner while the Unity panel loads", () => {
  it("goes when the project is not a Unity project, so the panel shows nothing", async () => {
    const { loading, settle, view } = await render();
    expect(loading()).toBe(true);
    await settle(() => view.resolve({ unity: false }));
    expect(loading()).toBe(false);
  });

  it("goes when the view fails to load", async () => {
    const { loading, settle, view } = await render();
    expect(loading()).toBe(true);
    await settle(() => view.reject(new Error("unity is not installed")));
    expect(loading()).toBe(false);
  });
});
