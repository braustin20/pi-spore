// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { type WorkspaceTab, WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, ApiRequestError, type WebHost } from "@pi-spore/module-api";
import type { ArtifactInfo, ArtifactsEvent, Workspace } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
beforeEach(() => {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode, api: Partial<ApiClient>) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api as ApiClient}>{node}</ApiContext>,
    );
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
