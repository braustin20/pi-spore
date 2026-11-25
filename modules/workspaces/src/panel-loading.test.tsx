// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { workspacesWeb } from "./web.js";
import type { WorkspaceView } from "./web-contract.js";

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

/**
 * Each fake panel's `onLoaded`, by `<panel>:<workspace>`, so a test can end a panel's first load by hand. A panel
 * adds it on mount, as a real panel starts its first load on mount.
 */
const loadedBy = new Map<string, () => void>();

interface PanelProps {
  workspace: Workspace;
  onLoaded: () => void;
}

function FakePanel({ id, workspace, onLoaded }: PanelProps & { id: string }) {
  const [first] = useState(() => workspace.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first load reports, like a real panel.
  useEffect(() => {
    loadedBy.set(`${id}:${first}`, onLoaded);
  }, []);
  return <p data-panel={id}>first {first}</p>;
}

const PanelOne = (props: PanelProps) => <FakePanel id="one" {...props} />;
const PanelTwo = (props: PanelProps) => <FakePanel id="two" {...props} />;

const pages: WebPage[] = [];
let view: WorkspaceView | undefined;
workspacesWeb.setup({
  provide: (_key: unknown, value: unknown) => {
    view = value as WorkspaceView;
  },
  addPage: (page: WebPage) => pages.push(page),
} as unknown as WebHost);
view?.addPanel({ id: "one", order: 1, component: PanelOne });
view?.addPanel({ id: "two", order: 2, component: PanelTwo });
function workspacePage() {
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId");
  if (!page) throw new Error("the workspaces module did not add its workspace page");
  return page.component;
}
const Page = workspacePage();

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
  loadedBy.clear();
});

const api = {
  get: async () => ({ projects: [project] }),
  send: async () => ({}),
  subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
    onEvent({ type: "snapshot", workspaces: [workspace("w1"), workspace("w2")] });
    return () => {};
  },
} as unknown as ApiClient;

async function show(workspaceId: string) {
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={{ workspaceId }} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
}

async function render() {
  localStorage.setItem("pi-spore.workspaces.details", "1");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await show("w1");
  const details = container.querySelector('aside[aria-label="Workspace details"]');
  if (!details) throw new Error("the details panel did not render");
  return details;
}

const loading = (details: Element) =>
  [...details.querySelectorAll('[role="status"]')].some((status) =>
    status.textContent?.includes("Loading workspace"),
  );

const load = async (key: string) => {
  const onLoaded = loadedBy.get(key);
  if (!onLoaded) throw new Error(`no panel rendered as ${key}`);
  await act(async () => onLoaded());
};

describe("the workspace panels", () => {
  it("mount again for the next workspace", async () => {
    const details = await render();
    expect(details.querySelector('[data-panel="one"]')?.textContent).toBe("first w1");
    await show("w2");
    expect(details.querySelector('[data-panel="one"]')?.textContent).toBe("first w2");
  });

  it("show a spinner until every panel of the workspace has loaded", async () => {
    const details = await render();
    expect(loading(details)).toBe(true);
    await load("one:w1");
    expect(loading(details)).toBe(true);
    await load("two:w1");
    expect(loading(details)).toBe(false);

    await show("w2");
    expect(loading(details)).toBe(true);
    await load("one:w2");
    expect(loading(details)).toBe(true);
    await load("two:w2");
    expect(loading(details)).toBe(false);
  });

  it("ignore a late load of the last workspace's panels", async () => {
    const details = await render();
    await show("w2");
    await load("one:w1");
    await load("two:w1");
    expect(loading(details)).toBe(true);
    await load("one:w2");
    await load("two:w1");
    expect(loading(details)).toBe(true);
  });
});
