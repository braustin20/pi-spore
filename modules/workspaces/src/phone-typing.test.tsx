// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import { PHONE_QUERY, TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: Workspace = {
  id: "a",
  projectId: "p1",
  name: "Work a",
  slug: "a",
  isolation: "new",
  path: "/tmp/a",
  line: "spore/a",
  state: "active",
  createdAt: 0,
  updatedAt: 0,
};

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
  vi.unstubAllGlobals();
});

describe("the phone pane row", () => {
  it("hides while a text field has focus", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }));
    const Page = listPage();
    const api = {
      get: async () => ({ projects: [] }),
      send: async () => ({}),
      subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
        onEvent({ type: "snapshot", workspaces: [workspace] });
        return () => {};
      },
    } as unknown as ApiClient;
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Page params={{ workspaceId: "a" }} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
    const button = container.querySelector('button[aria-label="Workspaces"]');
    expect(button?.parentElement?.hasAttribute("data-hide-while-typing")).toBe(true);
  });
});
