// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Agent, DiffComment, Workspace } from "@pi-spore/shared";
import { PHONE_QUERY, TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: "W1" } as Workspace;

const comment: DiffComment = {
  id: "C1",
  workspaceId: "W1",
  path: "src/a.ts",
  side: "new",
  line: 3,
  code: "x",
  body: "Fix line 3.",
  createdAt: 0,
  staged: true,
};

const agent: Agent = {
  id: "A1",
  workspaceId: "W1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status: "waiting",
  statusSince: 0,
  createdAt: 0,
};

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  // Unmount first, so a dialog's portal under `document.body` does not leak into the next test.
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Renders a component of the module against an API whose event socket never replays a snapshot, so the comments on
 * screen can only come from the load on mount or an event.
 */
async function renderPanel(
  pick: "chat" | "tab",
  loadComments: () => Promise<unknown> = async () => ({ comments: [comment] }),
  answer: (path: string) => unknown = () => undefined,
) {
  const listeners: ((event: unknown) => void)[] = [];
  const asked: string[] = [];
  const blobs: string[] = [];
  const subscriptions = new Map<string, number>();
  let chatPanel: ComponentType<{ chatId: string }> | undefined;
  let tab: ComponentType<{ workspace: Workspace }> | undefined;
  changesWeb.setup({
    use: (key: unknown) =>
      key === AgentsWebKey
        ? { addChatPanel: (_id: string, panel: typeof chatPanel) => (chatPanel = panel) }
        : key === WorkspaceViewKey
          ? { addTab: (added: { component: typeof tab }) => (tab = added.component) }
          : undefined,
  } as unknown as WebHost);
  const api = {
    get: async (path: string) => {
      asked.push(path);
      if (path === "agents/A1") return { agent };
      const body = answer(path);
      if (body !== undefined) return body;
      if (path === "changes/workspaces/W1/comments") return loadComments();
      throw new Error(`unexpected GET ${path}`);
    },
    getBlob: async (path: string) => {
      blobs.push(path);
      return new Blob([path.endsWith("side=old") ? "old" : "newer"]);
    },
    subscribe: (topic: string, listener: (event: unknown) => void) => {
      listeners.push(listener);
      subscriptions.set(topic, (subscriptions.get(topic) ?? 0) + 1);
      return () => subscriptions.set(topic, (subscriptions.get(topic) ?? 0) - 1);
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    const Component = (pick === "chat" ? chatPanel : tab) as
      | ComponentType<{ chatId: string; workspace: Workspace }>
      | undefined;
    if (!Component) throw new Error("the changes module did not add its component");
    root = createRoot(container as HTMLElement);
    root.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Component chatId="A1" workspace={workspace} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  return {
    root: container,
    asked,
    blobs,
    subscriptions,
    emit: (event: unknown) => act(async () => listeners.map((l) => l(event))),
  };
}

describe("comments as a second subscriber", () => {
  it("shows the staged batch above the composer without a new event", async () => {
    const { root } = await renderPanel("chat");
    expect(root.textContent).toContain("1 diff comment will go with your next message");
  });

  it("shows the comments bar of the Changes tab without a new event", async () => {
    const { root } = await renderPanel("tab");
    expect(root.textContent).toContain("1 comment for the agent");
  });

  it.each(["chat", "tab"] as const)(
    "keeps a newer event when the first load answers late (%s)",
    async (pick) => {
      let answer: (body: unknown) => void = () => {};
      const { root, emit } = await renderPanel(
        pick,
        () => new Promise((resolve) => (answer = resolve)),
      );
      await emit({ type: "comments", comments: [comment] });
      await act(async () => answer({ comments: [] }));
      expect(root.textContent).toContain(pick === "chat" ? "1 diff comment" : "1 comment for");
    },
  );

  it("shows a failed load as an error, not as an empty batch", async () => {
    const { root } = await renderPanel("chat", async () => {
      throw new Error("down");
    });
    expect(root.textContent).toContain("down");
    expect(root.textContent).not.toContain("0 diff comments");
  });
});

describe("the Changes tab's first scope", () => {
  const answer = (path: string) =>
    path === "changes/workspaces/W1"
      ? {
          scopes: ["uncommitted", "staged", "line", "record"],
          base: "main",
          records: [],
          initialScope: "line",
        }
      : path.startsWith("changes/workspaces/W1/files?")
        ? { files: [], truncated: false }
        : undefined;
  const filesAsked = (asked: string[]) =>
    asked.filter((path) => path.startsWith("changes/workspaces/W1/files?"));

  it("opens on the summary's initial scope, then keeps the user's pick after a stale event", async () => {
    const { root, asked, emit } = await renderPanel("tab", undefined, answer);
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Which changes"]');
    expect(select?.selectedOptions[0]?.textContent).toBe("Branch since main");
    expect(filesAsked(asked)[0]).toBe("changes/workspaces/W1/files?scope=line");

    await act(async () => {
      if (!select) return;
      select.value = "uncommitted";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const before = filesAsked(asked).length;
    await emit({ type: "stale" });
    expect(filesAsked(asked).length).toBeGreaterThan(before);
    expect(filesAsked(asked).at(-1)).toBe("changes/workspaces/W1/files?scope=uncommitted");
    expect(select?.value).toBe("uncommitted");
  });

  it("opens on uncommitted and asks for its files when the summary fails", async () => {
    // The tab must not hang with no scope, so the files load still runs.
    const { root, asked } = await renderPanel("tab", undefined, (path) => {
      if (path === "changes/workspaces/W1") throw new Error("The summary failed");
      return answer(path);
    });
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Which changes"]');
    expect(select?.value).toBe("uncommitted");
    expect(filesAsked(asked)[0]).toBe("changes/workspaces/W1/files?scope=uncommitted");
  });
});

describe("the Changes tab's large view", () => {
  const file = (path: string) => ({
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
  });
  const answer = (path: string) =>
    path === "changes/workspaces/W1"
      ? { scopes: ["uncommitted"], records: [], initialScope: "uncommitted" }
      : path.startsWith("changes/workspaces/W1/files?")
        ? { files: [file("src/a.ts"), file("src/b.ts")], truncated: false }
        : path.startsWith("changes/workspaces/W1/diff?")
          ? {
              diffs: [
                {
                  file: file(new URLSearchParams(path.split("?")[1]).get("path") ?? ""),
                  hunks: [
                    {
                      oldStart: 1,
                      newStart: 1,
                      section: "",
                      lines: [{ kind: "add", newLine: 1, text: "x" }],
                    },
                  ],
                },
              ],
              truncated: false,
            }
          : undefined;
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const click = (element: Element | null | undefined) =>
    act(async () => {
      if (!element) throw new Error("nothing to click");
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const largeButton = (root: HTMLElement) => root.querySelector('button[aria-label="Large view"]');

  it("moves the whole view into a dialog and leaves a note in the tab", async () => {
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    expect(dialog()?.querySelector('ul[aria-label="Changed files"]')).not.toBeNull();
    expect(dialog()?.querySelector('select[aria-label="Which changes"]')).not.toBeNull();
    expect(root.querySelector('ul[aria-label="Changed files"]')).toBeNull();
    expect(root.querySelector('select[aria-label="Which changes"]')).toBeNull();
    expect(root.textContent).toContain("Open in the large view");
  });

  it("keeps the selected file after Escape closes the dialog", async () => {
    const { root } = await renderPanel("tab", undefined, answer);
    await click(root.querySelector('button[title="src/b.ts"]'));
    await click(largeButton(root));
    expect(dialog()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(root.querySelector('button[title="src/b.ts"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("keeps one changes subscription while the dialog is open", async () => {
    const { root, subscriptions } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    expect(dialog()).not.toBeNull();
    expect(subscriptions.get("changes:W1")).toBe(1);
  });

  const pointerDown = (element: Element | null | undefined) =>
    act(async () => {
      if (!element) throw new Error("nothing to press");
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

  it("closes on a click on the dialog's inset", async () => {
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    await pointerDown(dialog());
    await click(dialog());
    expect(dialog()).toBeNull();
    expect(root.querySelector('ul[aria-label="Changed files"]')).not.toBeNull();
  });

  it("has no large view button on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { root } = await renderPanel("tab", undefined, answer);
    expect(root.querySelector('ul[aria-label="Changed files"]')).not.toBeNull();
    expect(largeButton(root)).toBeNull();
  });

  it("stays open when a press that starts in the panel ends on the inset", async () => {
    // A drag that selects diff text and lets go past the panel's edge sends its click to the inset.
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    await pointerDown(dialog()?.querySelector('ul[aria-label="Changed files"]'));
    await click(dialog());
    expect(dialog()).not.toBeNull();
  });

  it("lets Escape in a comment form cancel the form, not close the dialog", async () => {
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    await click(dialog()?.querySelector('button[aria-label="Comment on line 1"]'));
    const textarea = dialog()?.querySelector('textarea[aria-label="Comment"]');
    expect(textarea).not.toBeNull();
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('textarea[aria-label="Comment"]')).toBeNull();
  });

  it("gives focus back to the Large view button when the dialog closes", async () => {
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(largeButton(root));
  });

  it("does not open again by itself after the screen was a phone for a while", async () => {
    let phone = false;
    const changes = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY && phone,
      addEventListener: (_type: string, listener: () => void) => changes.add(listener),
      removeEventListener: (_type: string, listener: () => void) => changes.delete(listener),
    }));
    const resize = (next: boolean) =>
      act(async () => {
        phone = next;
        for (const listener of changes) listener();
      });
    const { root } = await renderPanel("tab", undefined, answer);
    await click(largeButton(root));
    await resize(true);
    expect(dialog()).toBeNull();
    await resize(false);
    expect(dialog()).toBeNull();
    expect(largeButton(root)).not.toBeNull();
  });
});

describe("the Changes tab's image diff", () => {
  const answer =
    (path: string, status: string) =>
    (asked: string): unknown => {
      const file = { path, status, additions: 0, deletions: 0, binary: true };
      return asked === "changes/workspaces/W1"
        ? { scopes: ["uncommitted"], records: [], initialScope: "uncommitted" }
        : asked.startsWith("changes/workspaces/W1/files?")
          ? { files: [file], truncated: false }
          : asked.startsWith("changes/workspaces/W1/diff?")
            ? { diffs: [{ file, hunks: [], note: "binary" }], truncated: false }
            : undefined;
    };

  const stubUrls = () => {
    let next = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${next++}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  };

  it("shows the old and new picture of a modified image, with their sizes", async () => {
    stubUrls();
    const { root, blobs } = await renderPanel("tab", undefined, answer("shot.png", "modified"));
    expect(root.querySelectorAll("img")).toHaveLength(2);
    expect(root.querySelector('img[alt="shot.png before"]')).not.toBeNull();
    expect(root.querySelector('img[alt="shot.png after"]')).not.toBeNull();
    expect(blobs.sort()).toEqual([
      "changes/workspaces/W1/content?scope=uncommitted&path=shot.png&side=new",
      "changes/workspaces/W1/content?scope=uncommitted&path=shot.png&side=old",
    ]);
    expect(root.textContent).toContain("Before");
    expect(root.textContent).toContain("3 bytes");
    expect(root.textContent).toContain("After");
    expect(root.textContent).toContain("5 bytes");
    expect(root.textContent).not.toContain("Binary file");
  });

  it("shows only the new picture of an added image", async () => {
    stubUrls();
    const { root, blobs } = await renderPanel("tab", undefined, answer("shot.png", "added"));
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(blobs).toEqual([
      "changes/workspaces/W1/content?scope=uncommitted&path=shot.png&side=new",
    ]);
  });

  it("keeps the binary note for a file that is not an image", async () => {
    stubUrls();
    const { root, blobs } = await renderPanel("tab", undefined, answer("blob.bin", "modified"));
    expect(root.textContent).toContain("Binary file. Its contents are not shown.");
    expect(root.querySelector("img")).toBeNull();
    expect(blobs).toEqual([]);
  });
});
