// @vitest-environment happy-dom
import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Project, PrStatus, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { githubPrWeb } from "./web.js";

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

const NoNote = () => null;
const headId = "a".repeat(40);
const status = (workspaceId: string, withPr: boolean): PrStatus => ({
  workspaceId,
  publishable: true,
  defaults: { title: "Work", body: "" },
  ...(withPr
    ? {
        pr: {
          number: 12,
          url: "https://github.com/owner/repo/pull/12",
          title: "Work",
          state: "open",
          draft: false,
          line: "spore/work",
          base: "main",
          headId,
          review: "none",
          mergeable: "mergeable",
          checks: [],
        },
      }
    : {}),
  mergeWhenReady: false,
  watch: { state: "off", tries: 0, maxTries: 3 },
  tries: [],
  local: { headId, uncommitted: 0 },
});

/** Wires the real workspaces page to the real github-pr module, as the app does. */
function workspacePage() {
  const pages: WebPage[] = [];
  let view: unknown;
  workspacesWeb.setup({
    provide: (_key: unknown, value: unknown) => {
      view = value;
    },
    addPage: (page: WebPage) => pages.push(page),
  } as unknown as WebHost);
  githubPrWeb.setup({
    use: () => ({ ...(view as object), addApprovalView: () => {}, DeclineNote: NoNote }),
  } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/workspaces/:workspaceId");
  if (!page) throw new Error("the workspaces module did not add its page");
  return page.component;
}

const Page = workspacePage();

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

/** w1's PR status answers at once; w2's waits for the test. */
async function render() {
  let answerW2: (status: PrStatus) => void = () => {};
  const w2 = new Promise<PrStatus>((resolve) => {
    answerW2 = resolve;
  });
  const api = {
    get: async (path: string) => {
      if (path.startsWith("github-pr/workspaces/w1")) return status("w1", true);
      if (path.startsWith("github-pr/workspaces/w2")) return w2;
      if (path === "projects/settings") return { settings: [] };
      return { projects: [project] };
    },
    send: async () => ({}),
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      if (topic === "workspaces:list") {
        onEvent({ type: "snapshot", workspaces: [workspace("w1"), workspace("w2")] });
      }
      return () => {};
    },
  } as unknown as ApiClient;
  localStorage.setItem("pi-spore.workspaces.details", "1");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const show = (workspaceId: string) =>
    act(async () => {
      root?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Page params={{ workspaceId }} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
  await show("w1");
  const page = container;
  const text = () => page.textContent ?? "";
  return { show, text, answerW2: (shown: PrStatus) => act(async () => answerW2(shown)) };
}

describe("the PR panel when the workspace changes", () => {
  it("shows no PR of the old workspace, and a spinner until the new one answers", async () => {
    const { show, text, answerW2 } = await render();
    expect(text()).toContain("#12");
    expect(text()).not.toContain("Loading workspace");

    await show("w2");
    expect(text()).not.toContain("#12");
    expect(text()).toContain("Loading workspace");

    await answerW2(status("w2", false));
    expect(text()).not.toContain("#12");
  });

  it("drops the spinner once the panel has loaded", async () => {
    const { show, text, answerW2 } = await render();
    expect(text()).not.toContain("Loading workspace");
    await show("w2");
    expect(text()).toContain("Loading workspace");
    await answerW2(status("w2", false));
    expect(text()).not.toContain("Loading workspace");
  });
});
