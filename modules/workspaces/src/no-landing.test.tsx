// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This file never sets a landing page: the agent graph module is optional (ADR 0176).
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
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.location.hash = "";
});

describe("the list header without a landing page", () => {
  it("has no landing button, since the landing is only the create form", async () => {
    window.location.hash = "#/workspaces";
    const Page = listPage();
    const api = {
      get: async () => ({ projects: [] }),
      send: async () => ({}),
      subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
        onEvent({ type: "snapshot", workspaces: [] });
        return () => {};
      },
    } as unknown as ApiClient;
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Page params={{}} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
    const header = container.querySelector('aside[aria-label="Workspaces"]');
    if (!header) throw new Error("the workspace list did not render");
    expect(header.querySelector('a[aria-label="New workspace"]')).not.toBeNull();
    expect(header.querySelectorAll("a[aria-current]")).toHaveLength(0);
    expect(header.querySelector('a[href="#/workspaces"]')).toBeNull();
  });
});
