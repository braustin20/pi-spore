// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project } from "@pi-spore/shared";
import { PHONE_QUERY, TooltipProvider } from "@pi-spore/ui";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WorkspaceView, workspacesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects: Project[] = [
  { id: "p1", name: "Game", slug: "game", path: "/tmp/p1", vcs: "git", traits: [], createdAt: 0 },
  {
    id: "p2",
    name: "Notes",
    slug: "notes",
    path: "/tmp/p2",
    vcs: "folder",
    traits: [],
    createdAt: 0,
  },
];

/** The component another module sets as the landing page, as the agent graph will (ADR 0176). */
const Landing: ComponentType<{ projectId?: string | undefined }> = ({ projectId }) => (
  <p>Landing: {projectId ?? "all projects"}</p>
);

const pages: WebPage[] = [];
function setup(): WorkspaceView {
  let view: WorkspaceView | undefined;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value as WorkspaceView;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  if (!view) throw new Error("the workspaces module did not provide its view");
  return view;
}

const view = setup();
// The module holds one landing for its lifetime, so this file sets it once, as the app does at load.
view.setLanding(Landing, { label: "Agent graph", icon: () => <svg /> });

function page(route: string) {
  const found = pages.find((each) => each.path === route);
  if (!found) throw new Error(`the workspaces module did not add ${route}`);
  return found.component;
}

let container: HTMLElement | undefined;
let root: Root | undefined;
function unmount() {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
}
afterEach(() => {
  unmount();
  localStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

/**
 * Shows the workspaces page at the hash route `path`, with the params the router gives it and the fake api.
 * Every workspaces route shows one component, which reads the route it is on.
 */
async function render(path: string, params: Record<string, string> = {}) {
  unmount();
  window.location.hash = `#${path}`;
  const Page = page("/workspaces");
  const api = {
    get: async (route: string) =>
      route.endsWith("/lines") ? { lines: ["main"], current: "main" } : { projects },
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
          <Page params={params} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  if (!container.querySelector('aside[aria-label="Workspaces"]'))
    throw new Error(`${path} did not render the workspace list`);
  return container;
}

const newLink = (scope: Element) => scope.querySelector('a[aria-label="New workspace"]');
const createForm = (scope: Element) => scope.querySelector("form");
const chosenProject = (scope: Element) =>
  (scope.querySelector("form select") as HTMLSelectElement | null)?.value;

describe("the landing page", () => {
  it("shows what the other module set, with the route's project", async () => {
    const all = await render("/workspaces");
    expect(all.textContent).toContain("Landing: all projects");
    expect(createForm(all)).toBeNull();

    const one = await render("/workspaces/in/p1", { projectId: "p1" });
    expect(one.textContent).toContain("Landing: p1");
    expect(createForm(one)).toBeNull();
  });

  it("lets only one module set it", () => {
    // This file set the landing above, so this call is the second.
    expect(() => view.setLanding(Landing, { label: "Again", icon: () => <svg /> })).toThrow(/landing page is set twice/);
  });
});

describe("the new workspace page", () => {
  it("shows the create form, with the route's project chosen", async () => {
    const all = await render("/workspaces/new");
    expect(createForm(all)?.textContent ?? "no create form on the page").toContain(
      "Start workspace",
    );
    expect(chosenProject(all)).toBe("p1");

    const one = await render("/workspaces/new/in/p2", { projectId: "p2" });
    expect(chosenProject(one)).toBe("p2");
  });

  it("is one page with the other workspaces routes, added before /workspaces/:workspaceId", () => {
    const paths = pages.map((each) => each.path);
    // One component, so the view keeps its state as the route changes: the create opens the workspace it made.
    expect(page("/workspaces/new")).toBe(page("/workspaces"));
    expect(page("/workspaces/new/in/:projectId")).toBe(page("/workspaces/in/:projectId"));
    // The router takes the first page that matches, so `new` must not read as a workspace id.
    expect(paths.indexOf("/workspaces/new")).toBeLessThan(
      paths.indexOf("/workspaces/:workspaceId"),
    );
    expect(paths.indexOf("/workspaces/new/in/:projectId")).toBeLessThan(
      paths.indexOf("/workspaces/:workspaceId"),
    );
  });
});

describe("the New workspace button", () => {
  it("opens the new workspace page", async () => {
    const all = await render("/workspaces");
    expect(newLink(all)?.getAttribute("href")).toBe("#/workspaces/new");

    const one = await render("/workspaces/in/p1", { projectId: "p1" });
    expect(newLink(one)?.getAttribute("href")).toBe("#/workspaces/new/in/p1");
  });
});

const graphLink = (scope: Element) => scope.querySelector('a[aria-label="Agent graph"]');

describe("the landing button of the list header", () => {
  it("opens the landing page, with the module's label, and is lit while it is open", async () => {
    const landing = await render("/workspaces");
    expect(graphLink(landing)?.getAttribute("href")).toBe("#/workspaces");
    expect(graphLink(landing)?.getAttribute("aria-current")).toBe("page");

    const other = await render("/workspaces/new");
    expect(graphLink(other)?.getAttribute("href")).toBe("#/workspaces");
    expect(graphLink(other)?.hasAttribute("aria-current")).toBe(false);
  });

  it("keeps the list's project", async () => {
    const one = await render("/workspaces/in/p1", { projectId: "p1" });
    expect(graphLink(one)?.getAttribute("href")).toBe("#/workspaces/in/p1");
  });

  it("closes the list on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }));
    const phone = await render("/workspaces/new?pane=list");
    const link = graphLink(phone);
    if (!(link instanceof HTMLAnchorElement)) throw new Error("no Agent graph link on the phone list");
    await act(async () => link.click());
    // The landing is open and the list pane is gone.
    expect(phone.textContent).toContain("Landing: all projects");
    expect(phone.querySelector('aside[aria-label="Workspaces"]')).toBeNull();
  });
});
