// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Inbox, Question } from "@pi-spore/shared";
import { Toaster, TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attentionWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DialogCard = () => null;

const question = (extra: Partial<Question>): Question => ({
  id: "Q1",
  agentId: "A1",
  workspaceId: "W1",
  question: "Which colour?",
  steps: [{ type: "text", prompt: "Which colour?" }],
  state: "open",
  createdAt: 1,
  ...extra,
});

const inboxWith = (shown: Question): Inbox => ({
  items: [
    {
      kind: "question",
      at: 1,
      agentId: "A1",
      workspace: { id: "W1", name: "work", projectName: "proj", state: "active" },
      chat: { id: "C1", kind: "worker", active: true },
      question: shown,
    },
  ],
  interrupted: [],
  running: [],
});

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  // The toast list is module state, so close what a test left open.
  await act(async () => {
    for (const close of document.querySelectorAll<HTMLElement>("button[aria-label=Close]"))
      close.click();
  });
  // Unmount so no Toaster of an earlier test stays subscribed to the module-level toast list.
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.location.hash = "";
});

async function render(shown: Question) {
  let page: ComponentType | undefined;
  const send = vi.fn(async () => undefined);
  let emit: (event: unknown) => void = () => {};
  const api = {
    get: async () => undefined,
    send,
    subscribe: (_topic: string, listener: (event: unknown) => void) => {
      emit = listener;
      listener({ type: "inbox", inbox: inboxWith(shown) });
      return () => {};
    },
  } as unknown as ApiClient;
  const agents = {
    DialogCard,
    addChatPanel: () => {},
    setUserWaits: () => {},
  };
  const host = {
    api,
    use: (key: unknown) => {
      if (key === AgentsWebKey) return agents;
      throw new Error("unexpected module key");
    },
    provide: () => {},
    addPage: (added: { path: string; component: ComponentType }) => {
      if (added.path === "/") page = added.component;
    },
  } as unknown as WebHost;
  attentionWeb.setup(host);
  if (!page) throw new Error("the attention module did not add its Home page");
  const Home = page;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Home />
          <Toaster />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const choice = (name: string) => {
    const button = [...(container as HTMLElement).querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!button) throw new Error(`no button for ${name}`);
    return button;
  };
  const later = async (inbox: Inbox) => act(async () => emit({ type: "inbox", inbox }));
  return { choice, send, later, container: container as HTMLElement };
}

describe("the choices of a question on Home", () => {
  it("marks the recommended choice and no other", async () => {
    const { choice } = await render(question({ choices: ["red", "blue"], recommended: 1 }));
    const blue = choice("blue");
    expect(blue.getAttribute("aria-label")).toBe("blue (recommended)");
    expect(blue.textContent).toContain("Recommended");
    expect(blue.className).toContain("bg-accent");
    const red = choice("red");
    expect(red.hasAttribute("aria-label")).toBe(false);
    expect(red.textContent).not.toContain("Recommended");
    expect(red.className).not.toContain("bg-accent");
  });

  it("looks the same for every choice when none is recommended", async () => {
    const { choice, container } = await render(question({ choices: ["red", "blue"] }));
    expect(container.textContent).not.toContain("Recommended");
    for (const name of ["red", "blue"]) {
      expect(choice(name).className).not.toContain("bg-accent");
      expect(choice(name).hasAttribute("aria-label")).toBe(false);
    }
  });

  it("still answers only when the user clicks", async () => {
    const { choice, send } = await render(question({ choices: ["red", "blue"], recommended: 1 }));
    expect(send).not.toHaveBeenCalled();
    await act(async () => choice("red").click());
    expect(send).toHaveBeenCalledWith("POST", "attention/questions/Q1/answer", { answer: "red" });
  });
});

const toasts = () => document.querySelectorAll("li[data-radix-collection-item]");

const DESKTOP = "(hover: hover) and (pointer: fine)";

/** The inbox with the first question and a second one, which is the new item. */
const withSecond = (): Inbox => {
  const first = inboxWith(question({}));
  const second = inboxWith(question({ id: "Q2", question: "Which size?" }));
  return { ...first, items: [...first.items, ...second.items] };
};

function fakeScreen({ focused, desktop }: { focused: boolean; desktop: boolean }) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === DESKTOP && desktop,
    addEventListener() {},
    removeEventListener() {},
  }));
  const made: string[] = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    constructor(title: string) {
      made.push(title);
    }
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  return made;
}

describe("a new item on Home", () => {
  const NEW_TITLE = "Question from work (proj)";

  it("shows one toast, and no notification, while the page has focus on a desktop", async () => {
    const made = fakeScreen({ focused: true, desktop: true });
    const { later } = await render(question({}));
    await later(withSecond());
    expect(document.body.textContent).toContain(NEW_TITLE);
    expect(toasts()).toHaveLength(1);
    expect(made).toEqual([]);
  });

  it("makes a notification, and no toast, while the page has no focus", async () => {
    const made = fakeScreen({ focused: false, desktop: true });
    const { later } = await render(question({}));
    await later(withSecond());
    expect(made).toEqual([NEW_TITLE]);
    expect(toasts()).toHaveLength(0);
  });

  it("shows no toast on a touch screen", async () => {
    const made = fakeScreen({ focused: true, desktop: false });
    const { later } = await render(question({}));
    await later(withSecond());
    expect(toasts()).toHaveLength(0);
    expect(made).toEqual([]);
  });

  it("shows no toast for the items of the first inbox", async () => {
    fakeScreen({ focused: true, desktop: true });
    await render(question({}));
    expect(toasts()).toHaveLength(0);
  });

  it("shows no toast on the chat page of the item", async () => {
    fakeScreen({ focused: true, desktop: true });
    window.location.hash = "#/workspaces/W1/chats/C1";
    const { later } = await render(question({}));
    await later(withSecond());
    expect(toasts()).toHaveLength(0);
  });

  it("links the toast to the chat and closes it after 8 seconds", async () => {
    fakeScreen({ focused: true, desktop: true });
    vi.useFakeTimers();
    const { later } = await render(question({}));
    await later(withSecond());
    const open = document.querySelector<HTMLAnchorElement>("li[data-radix-collection-item] a");
    expect(open?.getAttribute("href")).toBe("#/workspaces/W1/chats/C1");
    await act(async () => {
      vi.advanceTimersByTime(8_100);
    });
    expect(toasts()).toHaveLength(0);
  });
});
