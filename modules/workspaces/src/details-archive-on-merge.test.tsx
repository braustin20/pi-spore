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

const workspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({
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
  ...over,
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
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render(workspaces: Workspace[], setting: boolean) {
  const Page = workspacesPage();
  const send = vi.fn(async () => ({}));
  const api = {
    get: async (path: string) =>
      path === "projects/settings"
        ? { settings: [{ key: "workspaces.archiveOnMerge", value: setting, source: "global" }] }
        : { projects: [project] },
    send,
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "snapshot", workspaces });
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
          <Page params={{ workspaceId: workspaces[0]?.id ?? "" }} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const details = container.querySelector('aside[aria-label="Workspace details"]');
  if (!details) throw new Error("the details panel did not render");
  return { details, send };
}

const archiveSelect = (details: Element) =>
  [...details.querySelectorAll("label")]
    .filter((label) => label.textContent?.includes("Archive when the PR merges"))
    .map((label) => label.querySelector("select"))
    .find((select) => select !== null) ?? undefined;

const chosen = (select: HTMLSelectElement) => select.options[select.selectedIndex]?.textContent;

const pick = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("the archive-on-merge select", () => {
  it("follows the setting when the workspace has no override", async () => {
    const { details } = await render([workspace("w1")], true);
    const select = archiveSelect(details);
    expect(select).toBeDefined();
    expect(chosen(select as HTMLSelectElement)).toBe("Use the setting (on)");
  });

  it("names the loaded setting when it is off", async () => {
    const { details } = await render([workspace("w1")], false);
    expect(chosen(archiveSelect(details) as HTMLSelectElement)).toBe("Use the setting (off)");
  });

  it("sends false when picking Off", async () => {
    const { details, send } = await render([workspace("w1")], true);
    await pick(archiveSelect(details) as HTMLSelectElement, "off");
    expect(send).toHaveBeenCalledWith("PATCH", "workspaces/w1", { archiveOnMerge: false });
  });

  it("clears the override when picking the setting again", async () => {
    const { details, send } = await render([workspace("w1", { archiveOnMerge: false })], true);
    expect(chosen(archiveSelect(details) as HTMLSelectElement)).toBe("Off");
    await pick(archiveSelect(details) as HTMLSelectElement, "");
    expect(send).toHaveBeenCalledWith("PATCH", "workspaces/w1", { archiveOnMerge: null });
  });

  it("is not on an archived workspace", async () => {
    const { details } = await render([workspace("w1", { state: "archived" })], true);
    expect(details.textContent).toContain("Work w1");
    expect(archiveSelect(details)).toBeUndefined();
  });
});
