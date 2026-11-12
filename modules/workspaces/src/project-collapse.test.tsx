// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (id: string, name: string): Project => ({
  id,
  name,
  slug: id,
  path: `/tmp/${id}`,
  vcs: "git",
  traits: [],
  createdAt: 0,
});

const workspace = (id: string, projectId: string): Workspace => ({
  id,
  projectId,
  name: `Work ${id}`,
  slug: id,
  isolation: "new",
  planner: false,
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
function unmount() {
  act(() => root?.unmount());
  container?.remove();
}
afterEach(() => {
  unmount();
  localStorage.clear();
});

async function render(
  projects: Project[],
  workspaces: Workspace[],
  params: Record<string, string> = {},
) {
  const Page = workspacesPage();
  const api = {
    get: async () => ({ projects }),
    send: async () => ({}),
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
  return list;
}

const group = (list: Element, name: string) => {
  const found = list.querySelector(`[role=group][aria-label="${name}"]`);
  if (!found) throw new Error(`no group ${name}`);
  return found;
};
const plans = (scope: Element) =>
  [...scope.querySelectorAll("a")].filter((a) => a.textContent?.startsWith("Plan"));

const two = [project("p1", "Game"), project("p2", "Tools")];
const work = [workspace("w1", "p1"), workspace("w2", "p1"), workspace("w3", "p2")];

describe("a project group in the list", () => {
  it("collapses to its name and count, and stays collapsed after a reload", async () => {
    let list = await render(two, work);
    const toggle = list.querySelector<HTMLButtonElement>('button[aria-label="Collapse Game"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle?.click());

    const game = group(list, "Game");
    expect(game.textContent).not.toContain("Work w1");
    expect(game.textContent).not.toContain("Active");
    expect(plans(game)).toEqual([]);
    expect(game.querySelector('[role="heading"]')?.textContent).toContain("2");
    const expand = game.querySelector('button[aria-label="Expand Game"]');
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    const tools = group(list, "Tools");
    expect(tools.textContent).toContain("Work w3");
    expect(plans(tools)).toHaveLength(1);

    unmount();
    list = await render(two, work);
    expect(group(list, "Game").textContent).not.toContain("Work w1");
    expect(list.querySelector('button[aria-label="Expand Game"]')).not.toBeNull();
    expect(group(list, "Tools").textContent).toContain("Work w3");
  });

  it("has no toggle when only one project shows", async () => {
    const one = await render([project("p1", "Game")], [workspace("w1", "p1")]);
    expect(one.querySelector("button[aria-expanded]")).toBeNull();
    expect(one.textContent).toContain("Work w1");
    unmount();

    localStorage.setItem("pi-spore.workspaces.collapsed.p1", "1");
    const filtered = await render(two, work, { projectId: "p1" });
    expect(filtered.querySelector("button[aria-expanded]")).toBeNull();
    expect(filtered.textContent).toContain("Work w1");
  });
});
