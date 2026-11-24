// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import {
  type ArtifactLink,
  type AttentionWeb,
  AttentionWebKey,
  attentionWeb,
} from "@pi-spore/mod-attention/web";
import { type WorkspaceTab, WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, ApiRequestError, type WebHost } from "@pi-spore/module-api";
import type {
  ArtifactInfo,
  ArtifactsEvent,
  Inbox,
  LinkedArtifact,
  Workspace,
} from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactView } from "./viewer.js";
import { artifactsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "Work",
  slug: "work",
  isolation: "new",
  planner: false,
  path: "/tmp/work",
  state: "active",
  createdAt: 0,
  updatedAt: 0,
};

const info = (scope: ArtifactInfo["scope"], path: string, more: Partial<ArtifactInfo> = {}) => ({
  scope,
  ownerId: scope === "workspace" ? "w1" : "p1",
  path,
  bytes: 2048,
  updatedAt: 0,
  ...more,
});

let container: HTMLElement | undefined;
let root: Root | undefined;
beforeEach(() => {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
});
afterEach(async () => {
  // Unmount, so a dialog in the document body does not stay for the next test.
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode, api: Partial<ApiClient>) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(<ApiContext value={api as ApiClient}>{node}</ApiContext>);
  });
  return container;
}

const local = (value: boolean) => vi.fn(async () => ({ local: value }));

const bytes = (text: string) => async () => new Blob([text]);

describe("ArtifactView", () => {
  it("renders Markdown as HTML elements", async () => {
    const root = await render(<ArtifactView source="s" name="plan.md" />, {
      getBlob: bytes("# Plan\n\nDo it."),
    });
    expect(root.querySelector("h1")?.textContent).toBe("Plan");
  });

  it("shows a Markdown image as a plain link, never an img", async () => {
    const root = await render(<ArtifactView source="s" name="plan.md" />, {
      getBlob: bytes("![chart](https://example.com/c.png)"),
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/c.png");
  });

  it("puts HTML in an iframe whose sandbox grants nothing", async () => {
    const root = await render(<ArtifactView source="s" name="page.html" />, {
      getBlob: bytes("<script>alert(1)</script><p>hi</p>"),
    });
    const frame = root.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it("puts other files in a pre", async () => {
    const root = await render(<ArtifactView source="s" name="data.json" />, {
      getBlob: bytes('{"a": 1}'),
    });
    expect(root.querySelector("pre")?.textContent).toBe('{"a": 1}');
  });

  it("shows an image through a blob URL", async () => {
    const root = await render(<ArtifactView source="s" name="shot.PNG" />, {
      getBlob: bytes("png"),
    });
    expect(root.querySelector("img")?.getAttribute("src")).toBe("blob:fake");
  });

  it("shows the error of a failed fetch", async () => {
    const root = await render(<ArtifactView source="s" name="plan.md" />, {
      getBlob: async () => {
        throw new ApiRequestError(404, "not_found", "No such artifact");
      },
    });
    expect(root.textContent).toContain("No such artifact");
  });
});

describe("the Artifacts tab", () => {
  function tab(): WorkspaceTab {
    let added: WorkspaceTab | undefined;
    artifactsWeb.setup({
      use: (key: unknown) => {
        if (key === WorkspaceViewKey) return { addTab: (each: WorkspaceTab) => (added = each) };
        if (key === AgentsWebKey) return { setFileLink: () => {} };
        if (key === AttentionWebKey) return { setArtifactLink: () => {} };
        throw new Error("unexpected interface");
      },
    } as unknown as WebHost);
    if (!added) throw new Error("the artifacts module did not add its tab");
    return added;
  }

  const event: ArtifactsEvent = {
    type: "artifacts",
    workspace: [info("workspace", "notes/plan.md"), info("workspace", "old.md")],
    project: [info("project", "design.md", { promotedFrom: "w0" })],
  };

  it("lists both scopes, and Promote sends the path", async () => {
    const send = vi.fn(async () => ({}));
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (topic, onEvent) => {
        expect(topic).toBe("artifacts:w1");
        onEvent(event);
        return () => {};
      },
      get: local(false),
      send,
    });
    expect(root.textContent).toContain("This workspace");
    expect(root.textContent).toContain("notes/plan.md");
    expect(root.textContent).toContain("Project");
    expect(root.textContent).toContain("design.md");
    expect(root.textContent).toContain("promoted from w0");

    const promote = root.querySelector("button");
    expect(promote?.textContent).toBe("Promote to project");
    await act(async () => promote?.click());
    expect(send).toHaveBeenCalledWith("POST", "artifacts/workspaces/w1/promote", {
      path: "notes/plan.md",
    });
  });

  it("shows the server's message when the project already has the file", async () => {
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent(event);
        return () => {};
      },
      get: local(false),
      send: async () => {
        throw new ApiRequestError(409, "artifact_exists", "The project already has notes/plan.md");
      },
    });
    await act(async () => root.querySelector("button")?.click());
    expect(root.querySelector("[role=alert]")?.textContent).toContain(
      "The project already has notes/plan.md",
    );
  });

  const openFolderButtons = (root: HTMLElement) =>
    [...root.querySelectorAll("button")].filter((b) => b.textContent === "Open folder");

  it("shows Open folder on every row when the request is local, and sends the path", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent(event);
        return () => {};
      },
      get: local(true),
      send,
    });
    const buttons = openFolderButtons(root);
    expect(buttons).toHaveLength(3);
    const design = buttons.find((b) => b.closest("li")?.textContent?.includes("design.md"));
    await act(async () => design?.click());
    expect(send).toHaveBeenCalledWith("POST", "artifacts/projects/p1/open-folder", {
      path: "design.md",
    });
  });

  it("hides Open folder when the request is not local", async () => {
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent(event);
        return () => {};
      },
      get: local(false),
    });
    expect(openFolderButtons(root)).toHaveLength(0);
  });

  it("shows the message of a failed Open folder", async () => {
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent(event);
        return () => {};
      },
      get: local(true),
      send: async () => {
        throw new ApiRequestError(500, "open_failed", "No file manager found");
      },
    });
    await act(async () => openFolderButtons(root)[0]?.click());
    expect(root.querySelector("[role=alert]")?.textContent).toContain("No file manager found");
  });

  it("opens a row in the viewer", async () => {
    const getBlob = vi.fn(async () => new Blob(["# Design"]));
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent(event);
        return () => {};
      },
      get: local(false),
      getBlob,
    });
    const row = [...root.querySelectorAll("a")].find((a) => a.textContent?.includes("design.md"));
    await act(async () => row?.click());
    expect(getBlob).toHaveBeenCalledWith("artifacts/projects/p1/file?path=design.md");
    expect(root.querySelector("h1")?.textContent).toBe("Design");
  });

  it("says plainly when both lists are empty", async () => {
    const Tab = tab().component;
    const root = await render(<Tab workspace={workspace} />, {
      subscribe: (_topic, onEvent) => {
        onEvent({ type: "artifacts", workspace: [], project: [] });
        return () => {};
      },
      get: local(false),
    });
    expect(root.textContent).toContain("No artifacts yet");
  });
});

describe("a file a question links", () => {
  function link(): ArtifactLink {
    let set: ArtifactLink | undefined;
    artifactsWeb.setup({
      use: (key: unknown) => {
        if (key === WorkspaceViewKey) return { addTab: () => {} };
        if (key === AgentsWebKey) return { setFileLink: () => {} };
        if (key === AttentionWebKey)
          return { setArtifactLink: (component: ArtifactLink) => (set = component) };
        throw new Error("unexpected interface");
      },
    } as unknown as WebHost);
    if (!set) throw new Error("the artifacts module did not set the question's artifact link");
    return set;
  }

  async function open(artifact: LinkedArtifact) {
    const getBlob = vi.fn(async () => new Blob(["# Plan A"]));
    const Link = link();
    const root = await render(<Link artifact={artifact}>Read a.md</Link>, { getBlob });
    const button = root.querySelector("button");
    expect(button?.textContent).toBe("Read a.md");
    await act(async () => button?.click());
    // The dialog sits in the document body, outside the card.
    expect(document.querySelector("[role=dialog] h1")?.textContent).toBe("Plan A");
    return getBlob;
  }

  it("opens a project file over the page", async () => {
    const getBlob = await open({ scope: "project", ownerId: "p1", path: "plans/a.md" });
    expect(getBlob).toHaveBeenCalledWith("artifacts/projects/p1/file?path=plans%2Fa.md");
  });

  it("opens a workspace file over the page", async () => {
    const getBlob = await open({ scope: "workspace", ownerId: "w1", path: "briefs/a.md" });
    expect(getBlob).toHaveBeenCalledWith("artifacts/workspaces/w1/file?path=briefs%2Fa.md");
  });
});

const DialogCard = () => null;

describe("a linked file on a question on Home", () => {
  /** Home of the real attention module, with the real artifact link the artifacts module sets on it. */
  function home(api: Partial<ApiClient>): ComponentType {
    let page: ComponentType | undefined;
    let attention: AttentionWeb | undefined;
    attentionWeb.setup({
      api,
      use: () => ({
        DialogCard,
        addChatPanel: () => {},
        setUserWaits: () => {},
        shownChat: () => undefined,
      }),
      provide: (_key: unknown, impl: AttentionWeb) => (attention = impl),
      addPage: (added: { path: string; component: ComponentType }) => {
        if (added.path === "/") page = added.component;
      },
    } as unknown as WebHost);
    artifactsWeb.setup({
      use: (key: unknown) => {
        if (key === WorkspaceViewKey) return { addTab: () => {} };
        if (key === AgentsWebKey) return { setFileLink: () => {} };
        if (key === AttentionWebKey) return attention;
        throw new Error("unexpected interface");
      },
    } as unknown as WebHost);
    if (!page) throw new Error("the attention module did not add its Home page");
    return page;
  }

  const inbox: Inbox = {
    items: [
      {
        kind: "question",
        at: 1,
        agentId: "A1",
        workspace: { id: "w1", name: "work", projectName: "proj", state: "active" },
        chat: { id: "C1", kind: "worker", active: true },
        question: {
          id: "Q1",
          agentId: "A1",
          workspaceId: "w1",
          question: "First?",
          steps: [
            { type: "text", prompt: "First?" },
            { type: "text", prompt: "Second?" },
          ],
          artifacts: [{ scope: "project", ownerId: "p1", path: "plans/a.md", label: "plan" }],
          state: "open",
          createdAt: 1,
        },
      },
    ],
    interrupted: [],
    running: [],
  };

  const answerBox = (root: HTMLElement) =>
    root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]');

  async function type(box: HTMLTextAreaElement | null, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        box,
        value,
      );
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const button = (root: HTMLElement, name: string) =>
    [...root.querySelectorAll("button")].find((each) => each.textContent?.includes(name));

  it("closes on Escape and leaves the question on its step with the draft", async () => {
    const api: Partial<ApiClient> = {
      get: async () => undefined,
      send: async () => undefined,
      subscribe: (_topic, onEvent) => {
        onEvent({ type: "inbox", inbox });
        return () => {};
      },
      getBlob: async () => new Blob(["# Plan A"]),
    };
    const Home = home(api);
    const root = await render(
      <TooltipProvider>
        <Home />
      </TooltipProvider>,
      api,
    );
    await type(answerBox(root), "red");
    await act(async () => button(root, "Next")?.click());
    await type(answerBox(root), "blue");
    expect(root.textContent).toContain("Step 2 of 2");

    await act(async () => button(root, "Read plan")?.click());
    const heading = document.querySelector("[role=dialog] h1");
    expect(heading?.textContent).toBe("Plan A");
    await act(async () => {
      heading?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(root.textContent).toContain("Step 2 of 2");
    expect(answerBox(root)?.value).toBe("blue");
    expect(button(root, "Read plan")).toBeDefined();
    await act(async () => button(root, "Back")?.click());
    expect(answerBox(root)?.value).toBe("red");
  });
});
