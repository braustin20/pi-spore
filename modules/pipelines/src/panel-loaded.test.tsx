// @vitest-environment happy-dom
import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { pipelinesWeb } from "./web.js";

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

const NoNote = () => null;

/** Wires the real workspaces page to the real pipelines module, as the app does. */
function workspacePage(api: ApiClient) {
  const pages: WebPage[] = [];
  let view: unknown;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  pipelinesWeb.setup({
    api,
    addPage: (page: WebPage) => pages.push(page),
    use: () => ({
      ...(view as object),
      addChatPanel: () => {},
      addApprovalView: () => {},
      DeclineNote: NoNote,
    }),
  } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId");
  if (!page) throw new Error("the workspaces module did not add its page");
  return page.component;
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

/** The panel's data comes from the topic; the test sends the first event when it likes. */
async function render() {
  let send: (event: unknown) => void = () => {};
  const api = {
    get: async (path: string) =>
      path === "projects/settings" ? { settings: [] } : { projects: [project] },
    send: async () => ({}),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === "workspaces:list") onEvent({ type: "snapshot", workspaces: [workspace] });
      if (topic === "pipelines:w1") send = onEvent;
      return () => {};
    },
  } as unknown as ApiClient;
  const Page = workspacePage(api);
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
    send: (event: unknown) => act(async () => send(event)),
  };
}

describe("the Details spinner while the Pipeline panel loads", () => {
  it("shows until the first run list arrives, then goes, with nothing to show", async () => {
    const { loading, send } = await render();
    expect(loading()).toBe(true);
    await send({ type: "runs", runs: [] });
    expect(loading()).toBe(false);
  });
});
