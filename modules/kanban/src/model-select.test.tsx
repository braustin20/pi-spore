// @vitest-environment happy-dom
import { type ApprovalViewProps, AttentionWebKey } from "@pi-spore/mod-attention/web";
import {
  type CreateWorkspaceFormProps,
  WorkspaceViewKey,
  workspacesWeb,
} from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost, type WebPage } from "@pi-spore/module-api";
import type { Approval, Card, Project, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kanbanWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "Game",
  slug: "game",
  path: "/tmp/game",
  vcs: "folder",
  traits: [],
  createdAt: 0,
};

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "Existing work",
  slug: "w1",
  isolation: "new",
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

const MODELS = {
  models: [
    { provider: "anthropic", id: "claude-a", name: "Claude A" },
    { provider: "openai", id: "gpt-x" },
  ],
};

const started = {
  card: card(),
  workspace,
  created: { workspace, copied: [], warnings: [], steps: [] },
  chatId: "chat1",
};

const DeclineNote = () => null;
const NoCreateForm = () => null;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

/** Sets up the real kanban and workspaces modules over a fake host, and renders the board at the card. */
async function render(cardFields: Partial<Card>, models: "ok" | "fails") {
  let CreateForm: ComponentType<CreateWorkspaceFormProps> | undefined;
  workspacesWeb.setup({
    provide: (key: unknown, impl: { CreateForm: typeof CreateForm }) => {
      if (key === WorkspaceViewKey) CreateForm = impl.CreateForm;
    },
    addPage: () => {},
  } as unknown as WebHost);

  const send = vi.fn(async (method: string, path: string) =>
    method === "PATCH" ? { card: card(cardFields) } : path.endsWith("/start") ? started : {},
  );
  const api = {
    get: async (path: string) => {
      if (path === "projects") return { projects: [project] };
      if (path === "workspaces") return { workspaces: [workspace] };
      if (path === "agents/models") {
        if (models === "fails") throw new Error("pi is not installed");
        return MODELS;
      }
      return { card: card(cardFields), history: [] };
    },
    send,
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "board", cards: [card(cardFields)] });
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

  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Page params={{ cardId: "c1" }} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  return { root: container, send };
}

const button = (root: Element, text: string) => {
  const found = [...root.querySelectorAll("button")].find((each) => each.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
};

/** The model selects in `root`, in page order. */
const modelSelects = (root: Element) =>
  [...root.querySelectorAll("label")]
    .filter((label) => label.firstChild?.textContent === "Model")
    .map((label) => label.querySelector("select") as HTMLSelectElement);

const optionLabels = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.textContent);

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Opens the new-workspace form and returns its model select. */
async function openNewWorkspaceForm(root: Element) {
  await act(async () => button(root, "Start in a new workspace").click());
  const aside = root.querySelector("aside") as Element;
  const form = [...aside.querySelectorAll("form")].find((each) =>
    each.textContent?.includes("Start workspace"),
  ) as HTMLFormElement;
  return { form, select: modelSelects(form)[0] as HTMLSelectElement };
}

const startBody = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.find((call) => String(call[1]).endsWith("/start"))?.[2];

describe("the model select in the new-workspace start form", () => {
  it("sends the picked model, and none for the default", async () => {
    const { root, send } = await render({}, "ok");
    const { form, select } = await openNewWorkspaceForm(root);
    expect(optionLabels(select)).toEqual([
      "Default (orchestrator setting)",
      "Claude A",
      "openai/gpt-x",
    ]);

    await choose(select, "openai/gpt-x");
    await act(async () => button(form, "Start workspace").click());
    expect(send).toHaveBeenCalledWith(
      "POST",
      "kanban/cards/c1/start",
      expect.objectContaining({ model: "openai/gpt-x" }),
    );
  });

  it("sends no model for the default option", async () => {
    const { root, send } = await render({}, "ok");
    const { form, select } = await openNewWorkspaceForm(root);
    await choose(select, "anthropic/claude-a");
    await choose(select, "");
    await act(async () => button(form, "Start workspace").click());
    expect(startBody(send)).toBeDefined();
    expect(startBody(send)).not.toHaveProperty("model");
  });

  it("names the card's model in the default label", async () => {
    const { root } = await render({ model: "anthropic/claude-a" }, "ok");
    const { select } = await openNewWorkspaceForm(root);
    expect(optionLabels(select)[0]).toBe("Card's model (anthropic/claude-a)");
  });

  it("warns when the list does not load, and still starts", async () => {
    const { root, send } = await render({}, "fails");
    const { form } = await openNewWorkspaceForm(root);
    expect(form.textContent).toContain("Could not load the model list: pi is not installed.");

    await act(async () => button(form, "Start workspace").click());
    expect(startBody(send)).toBeDefined();
    expect(startBody(send)).not.toHaveProperty("model");
  });
});

describe("the model select in the existing-workspace start form", () => {
  it("is disabled, explains why, and sends no model", async () => {
    const { root, send } = await render({}, "ok");
    await act(async () => button(root, "Start in an existing workspace").click());
    const aside = root.querySelector("aside") as Element;
    const form = [...aside.querySelectorAll("form")].find((each) =>
      each.textContent?.includes("Start here"),
    ) as HTMLFormElement;
    const [select] = modelSelects(form);
    expect(select?.disabled).toBe(true);
    expect(form.textContent).toContain("This workspace's chat keeps its model.");

    await choose(form.querySelector("select") as HTMLSelectElement, "w1");
    await act(async () => button(form, "Start here").click());
    expect(startBody(send)).toEqual({ workspaceId: "w1" });
  });
});

describe("the model select in the card editor", () => {
  const editorForm = (root: Element) =>
    [...root.querySelectorAll("form")].find((each) =>
      each.textContent?.includes("Save"),
    ) as HTMLFormElement;

  const patchBody = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.find((call) => call[0] === "PATCH")?.[2];

  it("saves the picked model, and null for the default", async () => {
    const { root, send } = await render({}, "ok");
    const form = editorForm(root);
    const select = modelSelects(form)[0] as HTMLSelectElement;

    await choose(select, "anthropic/claude-a");
    await act(async () => button(form, "Save").click());
    expect(patchBody(send)).toEqual(expect.objectContaining({ model: "anthropic/claude-a" }));

    send.mockClear();
    await choose(select, "");
    await act(async () => button(form, "Save").click());
    expect(patchBody(send)).toEqual(expect.objectContaining({ model: null }));
  });

  it("keeps the saved model when the list does not load", async () => {
    const { root, send } = await render({ model: "anthropic/claude-a" }, "fails");
    const form = editorForm(root);
    const select = modelSelects(form)[0] as HTMLSelectElement;
    expect(select.value).toBe("anthropic/claude-a");

    await act(async () => button(form, "Save").click());
    expect(patchBody(send)).toEqual(expect.objectContaining({ model: "anthropic/claude-a" }));
  });
});

describe("the model select in the card-start approval view", () => {
  const approval = (subject: unknown): Approval => ({
    id: "a1",
    kind: "card-start",
    agentId: "chat0",
    workspaceId: "w1",
    title: "Start card c1",
    reason: "It is next.",
    subject,
    state: "open",
    createdAt: 0,
  });
  const asked = { kind: "new", isolation: "new" } as const;
  const existing = { kind: "existing", workspaceId: "w1" } as const;

  /** Renders the view the kanban module adds for `card-start`; `board` says when the snapshot arrives. */
  async function renderApproval(
    subject: unknown,
    options: { cardFields?: Partial<Card>; board?: "first" | "later" } = {},
  ) {
    let View: ComponentType<ApprovalViewProps> | undefined;
    let deliver = () => {};
    const api = {
      get: async (path: string) => {
        if (path === "projects") return { projects: [project] };
        if (path === "workspaces") return { workspaces: [workspace] };
        if (path === "agents/models") return MODELS;
        throw new Error(`unexpected GET ${path}`);
      },
      send: vi.fn(),
      subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
        deliver = () => onEvent({ type: "board", cards: [card(options.cardFields)] });
        if (options.board !== "later") deliver();
        return () => {};
      },
    } as unknown as ApiClient;
    kanbanWeb.setup({
      api,
      addPage: () => {},
      use: (key: unknown) => {
        if (key === AttentionWebKey) {
          return {
            addApprovalView: (_kind: string, view: typeof View) => {
              View = view;
            },
            DeclineNote,
          };
        }
        if (key === WorkspaceViewKey) return { addPanel: () => {}, CreateForm: NoCreateForm };
        throw new Error("unexpected interface");
      },
    } as unknown as WebHost);
    if (!View) throw new Error("the kanban module did not add its card-start view");
    const Shown = View;

    const approve = vi.fn();
    container = document.body.appendChild(document.createElement("div"));
    await act(async () => {
      createRoot(container as HTMLElement).render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Shown approval={approval(subject)} busy={false} approve={approve} decline={vi.fn()} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
    const root = container;
    const target = [...root.querySelectorAll("label")]
      .find((label) => label.firstChild?.textContent === "Start in")
      ?.querySelector("select") as HTMLSelectElement;
    return { root, approve, target, deliver: () => act(async () => deliver()) };
  }

  it("approves with no changed subject when nothing changed", async () => {
    const { root, approve } = await renderApproval({ cardId: "c1", target: asked });
    await act(async () => button(root, "Approve and start").click());
    expect(approve).toHaveBeenCalledWith(undefined);
  });

  it("sends the picked model with the asked target", async () => {
    const { root, approve } = await renderApproval({ cardId: "c1", target: asked });
    await choose(modelSelects(root)[0] as HTMLSelectElement, "openai/gpt-x");
    await act(async () => button(root, "Approve and start").click());
    expect(approve).toHaveBeenCalledWith({ cardId: "c1", target: asked, model: "openai/gpt-x" });
  });

  it("preselects the subject's model, and drops it when Default is picked", async () => {
    const subject = { cardId: "c1", target: asked, model: "anthropic/claude-a" };
    const { root, approve } = await renderApproval(subject);
    const select = modelSelects(root)[0] as HTMLSelectElement;
    expect(select.value).toBe("anthropic/claude-a");

    await act(async () => button(root, "Approve and start").click());
    expect(approve).toHaveBeenLastCalledWith(undefined);

    await choose(select, "");
    await act(async () => button(root, "Approve and start").click());
    expect(approve).toHaveBeenLastCalledWith({ cardId: "c1", target: asked });
  });

  it("disables the select for an existing workspace and sends no model", async () => {
    const { root, approve, target } = await renderApproval({ cardId: "c1", target: asked });
    const select = modelSelects(root)[0] as HTMLSelectElement;
    await choose(select, "openai/gpt-x");

    await choose(target, JSON.stringify(existing));
    const disabled = modelSelects(root)[0] as HTMLSelectElement;
    expect(disabled.disabled).toBe(true);
    expect(optionLabels(disabled)).toEqual(["The chat's current model"]);
    expect(root.textContent).toContain("This workspace's chat keeps its model.");

    await act(async () => button(root, "Approve and start").click());
    expect(approve).toHaveBeenCalledWith({ cardId: "c1", target: existing });
  });

  it("names the card's model once the board arrives after the first render", async () => {
    const { root, deliver } = await renderApproval(
      { cardId: "c1", target: asked },
      { cardFields: { model: "anthropic/claude-a" }, board: "later" },
    );
    expect(optionLabels(modelSelects(root)[0] as HTMLSelectElement)[0]).toBe(
      "Default (orchestrator setting)",
    );

    await deliver();
    expect(optionLabels(modelSelects(root)[0] as HTMLSelectElement)[0]).toBe(
      "Card's model (anthropic/claude-a)",
    );
  });
});
