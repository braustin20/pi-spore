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
/** How often the fake panels rendered, to see that a repeated `onLoaded` does not render the column again. */
let renders = 0;

interface PanelProps {
  workspace: Workspace;
  onLoaded: () => void;
}

function FakePanel({ id, workspace, onLoaded }: PanelProps & { id: string }) {
  const [first] = useState(() => workspace.id);
  renders += 1;
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
view?.addTab({ id: "other", title: "Other", order: 1, component: () => <p>other</p> });
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

const detailsTab = (details: Element) => {
  const trigger = [...details.querySelectorAll('[role="tab"]')].find((each) =>
    each.textContent?.startsWith("Details"),
  );
  if (!trigger) throw new Error("no Details tab");
  return trigger;
};

/** Whether the status row and the Details tab's spinner show. The tab's name stays "Details" either way. */
const loading = (details: Element) => {
  const trigger = detailsTab(details);
  expect(trigger.textContent).toBe("Details");
  return {
    status: [...details.querySelectorAll('[role="status"]')].some((status) =>
      status.textContent?.includes("Loading workspace"),
    ),
    tab: trigger.querySelector('span[aria-hidden="true"]') !== null,
  };
};
const shown = { status: true, tab: true };
const gone = { status: false, tab: false };

const load = async (key: string) => {
  const onLoaded = loadedBy.get(key);
  if (!onLoaded) throw new Error(`no panel rendered as ${key}`);
  await act(async () => onLoaded());
};

const openTab = async (details: Element, name: string) => {
  const trigger = [...details.querySelectorAll('[role="tab"]')].find((each) =>
    each.textContent?.startsWith(name),
  );
  if (!trigger) throw new Error(`no ${name} tab`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
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
    expect(loading(details)).toEqual(shown);
    await load("one:w1");
    expect(loading(details)).toEqual(shown);
    await load("two:w1");
    expect(loading(details)).toEqual(gone);

    await show("w2");
    expect(loading(details)).toEqual(shown);
    await load("one:w2");
    expect(loading(details)).toEqual(shown);
    await load("two:w2");
    expect(loading(details)).toEqual(gone);
  });

  it("ignore a late load of the last workspace's panels", async () => {
    const details = await render();
    await show("w2");
    await load("one:w1");
    await load("two:w1");
    expect(loading(details)).toEqual(shown);
    await load("one:w2");
    await load("two:w1");
    expect(loading(details)).toEqual(shown);
    await load("two:w2");
    expect(loading(details)).toEqual(gone);
  });

  it("ignore a late load of an earlier mount of the same workspace", async () => {
    const details = await render();
    const earlier = [loadedBy.get("one:w1"), loadedBy.get("two:w1")];
    await show("w2");
    await show("w1");
    await act(async () => {
      for (const onLoaded of earlier) onLoaded?.();
    });
    expect(loading(details)).toEqual(shown);
  });

  it("do not render again when a panel says it loaded twice", async () => {
    await render();
    await load("one:w1");
    const before = renders;
    await load("one:w1");
    expect(renders).toBe(before);
  });

  it("show no spinner while another tab is open, and load again on the way back to Details", async () => {
    const details = await render();
    await load("one:w1");
    await load("two:w1");
    await openTab(details, "Other");
    expect(details.textContent).toContain("other");
    expect(loading(details)).toEqual({ status: false, tab: false });

    await show("w2");
    expect(loading(details)).toEqual({ status: false, tab: false });
    await openTab(details, "Details");
    expect(loading(details)).toEqual(shown);
    await load("one:w2");
    await load("two:w2");
    expect(loading(details)).toEqual(gone);

    await openTab(details, "Other");
    await openTab(details, "Details");
    expect(loading(details)).toEqual(shown);
    await load("one:w2");
    await load("two:w2");
    expect(loading(details)).toEqual(gone);
  });
});
