// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspacesWeb } from "./web.js";

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

const workspace = (id: string, planner = false): Workspace => ({
  id,
  projectId: "p1",
  name: planner ? "Plan" : `Work ${id}`,
  slug: id,
  isolation: planner ? "in-place" : "new",
  planner,
  path: `/tmp/${id}`,
  state: "active",
  createdAt: 0,
  updatedAt: 0,
});

function workspacesPage() {
  const pages: WebPage[] = [];
  workspacesWeb.setup({
    provide: () => {},
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces");
  if (!page) throw new Error("the workspaces module did not add its page");
  return page.component;
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.location.hash = "";
  vi.restoreAllMocks();
});

async function render(
  workspaces: Workspace[],
  params: Record<string, string> = {},
  send: (method: string, path: string, body?: unknown) => Promise<unknown> = async () => ({}),
) {
  const Page = workspacesPage();
  const sent = vi.fn(send);
  const api = {
    get: async () => ({ projects: [project] }),
    send: sent,
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "snapshot", workspaces });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={params} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const list = container.querySelector('aside[aria-label="Workspaces"]');
  if (!list) throw new Error("the list did not render");
  return { list, send: sent };
}

const planRow = (list: Element) =>
  [...list.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.startsWith("Plan"));

describe("the Plan entry", () => {
  it("shows first under a project with no workspaces, and links to its planner", async () => {
    const empty = await render([]);
    expect(planRow(empty.list)?.textContent).toContain("Cards only");
    expect(empty.list.textContent).not.toContain("No workspaces.");
    act(() => root?.unmount());
    container?.remove();

    const { list } = await render([workspace("w1"), workspace("plan", true)]);
    const rows = [...list.querySelectorAll("a[href^='#/workspaces/']")];
    expect(rows[0]?.getAttribute("href")).toBe("#/workspaces/plan");
    expect(list.textContent).not.toContain("Work plan");
  });

  it("is not offered for a removed project", async () => {
    const gone = (id: string, planner = false) => ({
      ...workspace(id, planner),
      projectId: "gone",
    });
    const { list } = await render([gone("w9"), gone("plan9", true)]);
    expect(list.textContent).toContain("Work w9");
    const plans = [...list.querySelectorAll("a")].filter((a) => a.textContent?.startsWith("Plan"));
    expect(plans.map((a) => a.closest("[role=group]")?.getAttribute("aria-label"))).toEqual([
      "Game",
    ]);
  });

  it("makes the planner workspace and opens it when there is none", async () => {
    const { list, send } = await render([workspace("w1")], {}, async () => ({
      workspace: workspace("plan", true),
    }));
    await act(async () => planRow(list)?.click());
    expect(send).toHaveBeenCalledWith("POST", "workspaces/planner", { projectId: "p1" });
    expect(window.location.hash).toBe("#/workspaces/plan");
  });

  it("shows the error of a failed make in the list", async () => {
    const { list } = await render([], {}, async () => {
      throw new Error("Project p1 not found");
    });
    await act(async () => planRow(list)?.click());
    expect(list.textContent).toContain("Project p1 not found");
    expect(window.location.hash).toBe("");
  });
});

describe("a planner workspace page", () => {
  it("has no details column, and a normal one still has it", async () => {
    const planner = await render([workspace("plan", true)], { workspaceId: "plan" });
    expect(planRow(planner.list)?.getAttribute("aria-current")).toBe("page");
    expect(document.body.textContent).not.toContain("Details");
    expect(document.querySelector('[aria-label="Show details"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();

    await render([workspace("w1")], { workspaceId: "w1" });
    expect(
      document.querySelector('aside[aria-label="Workspace details"]') ??
        document.querySelector('[aria-label="Show details"]'),
    ).not.toBeNull();
  });
});
