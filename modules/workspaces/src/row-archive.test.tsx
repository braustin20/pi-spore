// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = (id: string, state: Workspace["state"]): Workspace => ({
  id,
  projectId: "p1",
  name: `Work ${id}`,
  slug: id,
  isolation: "new",
  path: `/tmp/${id}`,
  line: `spore/${id}`,
  state,
  createdAt: 0,
  updatedAt: 0,
});

function listPage() {
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
afterEach(() => {
  container?.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render(workspaces: Workspace[]) {
  const Page = listPage();
  const send = vi.fn(async (_method: string, path: string) => ({
    workspace: { ...workspace(path.split("/")[1] ?? "", "archived") },
    steps: [],
  }));
  const api = {
    get: async () => ({ projects: [] }),
    send,
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "snapshot", workspaces });
      return () => {};
    },
  } as unknown as ApiClient;
  localStorage.setItem("pi-spore.workspaces.archived", "1");
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={{}} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const list = container.querySelector('aside[aria-label="Workspaces"]');
  if (!list) throw new Error("the list did not render");
  return { list, send };
}

const archiveButton = (list: Element, name: string) =>
  list.querySelector<HTMLButtonElement>(`button[aria-label="Archive ${name}"]`);

describe("the list row archive button", () => {
  it("is on active and parked rows only, and sits outside the row link", async () => {
    const { list } = await render([
      workspace("a", "active"),
      workspace("p", "parked"),
      workspace("x", "archived"),
    ]);
    expect(list.textContent).toContain("Work x");
    expect(archiveButton(list, "Work a")).not.toBeNull();
    expect(archiveButton(list, "Work p")).not.toBeNull();
    expect(archiveButton(list, "Work x")).toBeNull();
    expect(archiveButton(list, "Work a")?.closest("a")).toBeNull();
  });

  it("archives after a yes, and does nothing after a no", async () => {
    const { list, send } = await render([workspace("a", "active")]);
    const button = archiveButton(list, "Work a") as HTMLButtonElement;

    const dialogButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find(
        (each) => each.textContent === label,
      );
    await act(async () => button.click());
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      'Archive "Work a"?',
    );
    await act(async () => dialogButton("Cancel")?.click());
    expect(send).not.toHaveBeenCalled();

    await act(async () => button.click());
    await act(async () => dialogButton("Archive")?.click());
    expect(send).toHaveBeenCalledWith("POST", "workspaces/a/archive", {});
  });
});
