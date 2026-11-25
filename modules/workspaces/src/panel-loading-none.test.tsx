// @vitest-environment happy-dom
// Its own file: `addPanel` fills a list at module level, and this test needs a page with no panels.
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function workspacePage() {
  const pages: WebPage[] = [];
  workspacesWeb.setup({
    provide: () => {},
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId");
  if (!page) throw new Error("the workspaces module did not add its workspace page");
  return page.component;
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

it("shows no loading spinner when no module added a panel", async () => {
  const Page = workspacePage();
  const api = {
    get: async () => ({ projects: [] }),
    send: async () => ({}),
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "snapshot", workspaces: [workspace] });
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
  const details = container.querySelector('aside[aria-label="Workspace details"]');
  if (!details) throw new Error("the details panel did not render");
  expect(details.textContent).toContain("Details");
  expect(details.textContent).not.toContain("Loading workspace");
  expect(details.querySelector('[role="tab"] span[aria-hidden="true"]')).toBeNull();
});
