// @vitest-environment happy-dom
import { AttentionWebKey } from "@pi-spore/mod-attention/web";
import {
  type CreateWorkspaceFormProps,
  WorkspaceViewKey,
  workspacesWeb,
} from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Card, CreateWorkspaceResponse, Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kanbanWeb } from "./web.js";

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

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "Fix crafting",
  slug: "w1",
  isolation: "new",
  planner: false,
  path: "/tmp/w1",
  line: "spore/w1",
  state: "active",
  createdAt: 0,
  updatedAt: 0,
};

const card = (fields: Partial<Card> = {}): Card => ({
  id: "c1",
  title: "Fix crafting",
  body: "",
  projectId: "p1",
  labels: [],
  column: "backlog",
  position: 0,
  blockedBy: [],
  blocked: false,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

const startedWith = (created: Partial<CreateWorkspaceResponse> = {}) => ({
  card: card(),
  workspace,
  created: { workspace, copied: [], warnings: [], steps: [], ...created },
  chatId: "chat1",
});

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>;

const DeclineNote = () => null;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
  window.location.hash = "";
  vi.restoreAllMocks();
});

/** Renders the real board page over a fake host with `cards`; `send` answers every write. */
async function render(
  cards: Card[],
  send: Send,
  options: { params?: Record<string, string>; workspaces?: () => Workspace[] } = {},
) {
  let CreateForm: ComponentType<CreateWorkspaceFormProps> | undefined;
  workspacesWeb.setup({
    provide: (key: unknown, impl: { CreateForm: typeof CreateForm }) => {
      if (key === WorkspaceViewKey) CreateForm = impl.CreateForm;
    },
    addPage: () => {},
  } as unknown as WebHost);

  const sent = vi.fn(send);
  let deliver = (_cards: Card[]) => {};
  const api = {
    get: async (path: string) => {
      if (path === "projects") return { projects: [project] };
      if (path === "workspaces") return { workspaces: options.workspaces?.() ?? [] };
      if (path === "agents/models") return { models: [] };
      return { card: cards[0], history: [] };
    },
    send: sent,
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      deliver = (next) => onEvent({ type: "board", cards: next });
      deliver(cards);
      return () => {};
    },
  } as unknown as ApiClient;

  const pages: WebPage[] = [];
  kanbanWeb.setup({
    api,
    addPage: (page: WebPage) => pages.push(page),
    use: (key: unknown) => {
      if (key === AttentionWebKey) return { addApprovalView: () => {}, DeclineNote };
      if (key === WorkspaceViewKey) return { addPanel: () => {}, CreateForm };
      throw new Error("unexpected interface");
    },
  } as unknown as WebHost);
  const page = pages.find((each) => each.path === "/board/:cardId");
  if (!page) throw new Error("the kanban module did not add its card page");
  const Page = page.component;

  const root = document.body.appendChild(document.createElement("div"));
  container = root;
  const reactRoot: Root = createRoot(root);
  const show = (params: Record<string, string>) =>
    act(async () => {
      reactRoot.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Page params={params} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
  await show(options.params ?? {});
  return { root, send: sent, show, deliver: (next: Card[]) => act(async () => deliver(next)) };
}

const startButton = (root: Element, title: string) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="Start: ${title}"]`);

const click = (element: HTMLElement | null) =>
  act(async () => {
    if (!element) throw new Error("nothing to click");
    element.click();
  });

const buttonNamed = (text: string) => {
  const found = [...document.querySelectorAll("button")].find((each) => each.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
};

const starts = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter((call) => String(call[1]).endsWith("/start"));

describe("the Start button on a board card", () => {
  it("shows only for a card with a project, no workspace, and not done", async () => {
    const { root } = await render(
      [
        card(),
        (({ projectId: _none, ...rest }) => rest)(card({ id: "c2", title: "No project" })),
        card({ id: "c3", title: "Has workspace", workspaceId: "w1" }),
        card({ id: "c4", title: "Finished", column: "done" }),
      ],
      async () => ({}),
    );
    expect(startButton(root, "Fix crafting")).not.toBeNull();
    expect(startButton(root, "No project")).toBeNull();
    expect(startButton(root, "Has workspace")).toBeNull();
    expect(startButton(root, "Finished")).toBeNull();
  });

  it("starts in a new workspace with one click and opens it", async () => {
    const { root, send } = await render([card()], async () => startedWith());
    await click(startButton(root, "Fix crafting"));
    expect(send.mock.calls).toEqual([
      ["POST", "kanban/cards/c1/start", { projectId: "p1", isolation: "new" }],
    ]);
    expect(window.location.hash).toBe("#/workspaces/w1");
  });

  it("asks before a blocked card starts", async () => {
    const blocked = card({
      blocked: true,
      blockedBy: [{ kind: "card", id: "c9", title: "Make items", column: "backlog", open: true }],
    });
    const { root, send } = await render([blocked], async () => startedWith());
    await click(startButton(root, "Fix crafting"));
    expect(document.body.textContent).toContain("Card is blocked");
    expect(send).not.toHaveBeenCalled();

    await click(buttonNamed("Start anyway"));
    expect(send.mock.calls).toEqual([
      [
        "POST",
        "kanban/cards/c1/start",
        { projectId: "p1", isolation: "new", confirmBlocked: true },
      ],
    ]);
  });

  it("sends one request when clicked again while it runs", async () => {
    let finish = (_body: unknown) => {};
    const { root, send } = await render(
      [card()],
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const button = startButton(root, "Fix crafting");
    await click(button);
    await click(button);
    expect(starts(send)).toHaveLength(1);
    await act(async () => finish(startedWith()));
    expect(window.location.hash).toBe("#/workspaces/w1");
  });

  it("opens the card and shows the warnings of the start", async () => {
    const { root, show } = await render([card()], async () =>
      startedWith({ warnings: ["Could not copy .env"] }),
    );
    await click(startButton(root, "Fix crafting"));
    expect(window.location.hash).toBe("#/board/c1");

    await show({ cardId: "c1" });
    const aside = root.querySelector("aside") as Element;
    expect(aside.textContent).toContain("Could not copy .env");
  });

  it("shows the warnings and the new workspace of a card that is open", async () => {
    let finish = (_body: unknown) => {};
    let workspaces: Workspace[] = [];
    window.location.hash = "#/board/c1";
    const { root, deliver } = await render(
      [card()],
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { params: { cardId: "c1" }, workspaces: () => workspaces },
    );
    await click(startButton(root, "Fix crafting"));
    // The server makes the workspace and sends the board before the start answers.
    workspaces = [workspace];
    await deliver([card({ column: "in-progress", workspaceId: "w1" })]);
    await act(async () => finish(startedWith({ warnings: ["Could not run the setup script"] })));

    const aside = root.querySelector("aside") as Element;
    expect(aside.textContent).toContain("Could not run the setup script");
    expect(aside.querySelector('a[href="#/workspaces/w1"]')).not.toBeNull();
  });

  it("shows the server's error on the card", async () => {
    const { root } = await render([card()], async () => {
      throw new Error("The project has no default branch");
    });
    await click(startButton(root, "Fix crafting"));
    const tile = startButton(root, "Fix crafting")?.closest("li") as Element;
    expect(tile.textContent).toContain("The project has no default branch");
    expect(window.location.hash).toBe("");
  });
});

describe("the start targets of an open card", () => {
  it("leave out the planner workspace", async () => {
    const planner: Workspace = { ...workspace, id: "plan", name: "Plan", planner: true };
    await render([card()], async () => ({}), {
      params: { cardId: "c1" },
      workspaces: () => [planner],
    });
    expect(buttonNamed("Start in an existing workspace").disabled).toBe(true);
  });
});
