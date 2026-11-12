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

/** A question with `choices` gets the old-form step the server makes for it. */
const question = (extra: Partial<Question>): Question => ({
  id: "Q1",
  agentId: "A1",
  workspaceId: "W1",
  question: "Which colour?",
  steps: extra.choices
    ? [
        {
          type: "select",
          prompt: extra.question ?? "Which colour?",
          options: extra.choices.map((label) => ({ label })),
          ...(extra.recommended === undefined ? {} : { recommended: extra.recommended }),
          allowOther: true,
        },
      ]
    : [{ type: "text", prompt: "Which colour?" }],
  state: "open",
  createdAt: 1,
  ...extra,
});

const withSteps = (steps: Question["steps"]): Question =>
  question({ question: steps[0]?.prompt ?? "", steps });

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
/** The chat the fake chat pane shows, as `AgentsWeb.shownChat` tells it. */
let shownChat: string | undefined;
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
  shownChat = undefined;
  sessionStorage.clear();
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
    shownChat: () => shownChat,
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
  const shownIn = container as HTMLElement;
  /** The option row (radio or checkbox) of `label`. */
  const option = (label: string) => {
    const row = [...shownIn.querySelectorAll<HTMLElement>("[role=radio],[role=checkbox]")].find(
      // A row's text starts with its number.
      (candidate) => candidate.textContent?.replace(/^\d+/, "").startsWith(label),
    );
    if (!row) throw new Error(`no option ${label}`);
    return row;
  };
  const click = async (element: HTMLElement) => act(async () => element.click());
  const press = async (element: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    });
  const type = async (label: string, value: string) => {
    const box = shownIn.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    if (!box) throw new Error(`no text box ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        box,
        value,
      );
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return box;
  };
  const unmount = async () => {
    await act(async () => root?.unmount());
    root = undefined;
    shownIn.remove();
  };
  return { choice, send, later, container: shownIn, option, click, press, type, unmount };
}

const checked = (element: HTMLElement) => element.getAttribute("aria-checked") === "true";

describe("the choices of a question on Home", () => {
  it("marks the recommended choice and no other", async () => {
    const { option } = await render(question({ choices: ["red", "blue"], recommended: 1 }));
    expect(option("blue").textContent).toContain("Recommended");
    expect(option("red").textContent).not.toContain("Recommended");
    // Advice only: nothing is picked for the user.
    expect(checked(option("blue"))).toBe(false);
    expect(option("blue").className).not.toContain("bg-accent");
  });

  it("looks the same for every choice when none is recommended", async () => {
    const { option, container } = await render(question({ choices: ["red", "blue"] }));
    expect(container.textContent).not.toContain("Recommended");
    for (const name of ["red", "blue"]) expect(option(name).className).not.toContain("bg-accent");
  });

  it("selects on a click and answers only on Send answer", async () => {
    const { option, choice, click, send, container } = await render(
      question({ choices: ["red", "blue"], recommended: 1 }),
    );
    expect(container.textContent).not.toContain("Step 1");
    expect(choice("Send answer").disabled).toBe(true);
    await click(option("red"));
    expect(checked(option("red"))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await click(choice("Send answer"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("POST", "attention/questions/Q1/answer", {
      answers: [{ type: "select", label: "red" }],
    });
  });
});

describe("a question with several steps", () => {
  const plan = withSteps([
    {
      type: "select",
      prompt: "Which plan?",
      options: [
        { label: "Alpha", preview: "Alpha preview" },
        { label: "Beta", preview: "Beta preview" },
      ],
    },
    {
      type: "multiselect",
      prompt: "Which parts?",
      options: [{ label: "x" }, { label: "y" }, { label: "z" }],
    },
    { type: "text", prompt: "Anything else?" },
  ]);

  it("keeps the answers on Back and sends them all at once on Submit", async () => {
    const { option, choice, click, type, send, container } = await render(plan);
    expect(container.textContent).toContain("Step 1 of 3");
    expect(choice("Next").disabled).toBe(true);
    await click(option("Alpha"));
    await click(choice("Next"));
    expect(container.textContent).toContain("Step 2 of 3");
    await click(option("x"));
    await click(option("z"));
    await click(choice("Next"));
    expect(container.textContent).toContain("Anything else?");
    await click(choice("Back"));
    expect(checked(option("x"))).toBe(true);
    expect(checked(option("y"))).toBe(false);
    expect(checked(option("z"))).toBe(true);
    await click(choice("Back"));
    expect(checked(option("Alpha"))).toBe(true);
    await click(choice("Next"));
    await click(choice("Next"));
    expect(choice("Send answer").disabled).toBe(true);
    await type("Your answer", "  a note  ");
    expect(send).not.toHaveBeenCalled();
    await click(choice("Send answer"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("POST", "attention/questions/Q1/answer", {
      answers: [
        { type: "select", label: "Alpha" },
        { type: "multiselect", labels: ["x", "z"] },
        { type: "text", text: "a note" },
      ],
    });
  });

  it("shows the preview of the selected option only", async () => {
    const { option, click, container } = await render(plan);
    expect(container.textContent).not.toContain("preview");
    await click(option("Beta"));
    expect(container.textContent).toContain("Beta preview");
    expect(container.textContent).not.toContain("Alpha preview");
  });

  it("renders no raw HTML from the agent", async () => {
    const { container } = await render(
      withSteps([
        {
          type: "select",
          prompt: "Pick <script>alert(1)</script> **one**",
          options: [
            { label: "Alpha", description: "<img src=x onerror=alert(1)> first" },
            { label: "Beta" },
          ],
        },
      ]),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("one");
  });

  it("keeps the answers across a remount until Submit", async () => {
    const twoSteps = withSteps([
      { type: "select", prompt: "Which plan?", options: [{ label: "Alpha" }, { label: "Beta" }] },
      { type: "confirm", prompt: "Ship it?" },
    ]);
    const first = await render(twoSteps);
    await first.click(first.option("Beta"));
    await first.click(first.choice("Next"));
    await first.unmount();
    const second = await render(twoSteps);
    expect(second.container.textContent).toContain("Step 2 of 2");
    await second.click(second.choice("Back"));
    expect(checked(second.option("Beta"))).toBe(true);
    await second.click(second.choice("Next"));
    await second.click(second.choice("Yes"));
    await second.click(second.choice("Send answer"));
    expect(second.send).toHaveBeenCalledWith("POST", "attention/questions/Q1/answer", {
      answers: [
        { type: "select", label: "Beta" },
        { type: "confirm", yes: true },
      ],
    });
    expect(sessionStorage.getItem("pi-spore:question:Q1")).toBeNull();
  });

  it("ignores a broken stored draft", async () => {
    sessionStorage.setItem("pi-spore:question:Q1", '{"step": 9, "answers": "no"}');
    const { container } = await render(plan);
    expect(container.textContent).toContain("Step 1 of 3");
  });

  it("moves with the keyboard", async () => {
    const { option, click, press, container } = await render(
      withSteps([
        {
          type: "select",
          prompt: "Which plan?",
          options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
        },
        { type: "text", prompt: "Why?" },
      ]),
    );
    await click(option("Alpha"));
    await press(option("Alpha"), "ArrowDown");
    expect(checked(option("Beta"))).toBe(true);
    expect(checked(option("Alpha"))).toBe(false);
    await press(option("Beta"), "Enter");
    expect(container.textContent).toContain("Step 2 of 2");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await press(box, "Escape");
    expect(container.textContent).toContain("Step 1 of 2");
    expect(checked(option("Beta"))).toBe(true);
  });

  it("answers a confirm step with No", async () => {
    const { choice, click, send } = await render(
      withSteps([{ type: "confirm", prompt: "Ship it?", recommended: true }]),
    );
    expect(choice("Yes").textContent).toContain("Recommended");
    expect(choice("No").textContent).not.toContain("Recommended");
    expect(choice("Send answer").disabled).toBe(true);
    await click(choice("No"));
    expect(choice("No").getAttribute("aria-pressed")).toBe("true");
    expect(choice("Yes").getAttribute("aria-pressed")).toBe("false");
    await click(choice("Send answer"));
    expect(send).toHaveBeenCalledWith("POST", "attention/questions/Q1/answer", {
      answers: [{ type: "confirm", yes: false }],
    });
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

function fakeScreen({
  focused,
  desktop,
  visible = true,
}: {
  focused: boolean;
  desktop: boolean;
  visible?: boolean;
}) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden");
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

  it("makes no toast and no notification for the chat on screen, opened without its id in the hash", async () => {
    const made = fakeScreen({ focused: true, desktop: true });
    window.location.hash = "#/workspaces/W1";
    shownChat = "C1";
    const { later } = await render(question({}));
    await later(withSecond());
    expect(toasts()).toHaveLength(0);
    expect(made).toEqual([]);
  });

  it("makes no notification for the chat on screen while the page is visible without focus", async () => {
    const made = fakeScreen({ focused: false, desktop: true });
    shownChat = "C1";
    const { later } = await render(question({}));
    await later(withSecond());
    expect(made).toEqual([]);
    expect(toasts()).toHaveLength(0);
  });

  it("shows a toast for an item of another chat than the one on screen", async () => {
    const made = fakeScreen({ focused: true, desktop: true });
    shownChat = "C2";
    const { later } = await render(question({}));
    await later(withSecond());
    expect(toasts()).toHaveLength(1);
    expect(made).toEqual([]);
  });

  it("makes a notification for the chat on screen while the page is hidden", async () => {
    const made = fakeScreen({ focused: false, desktop: true, visible: false });
    shownChat = "C1";
    const { later } = await render(question({}));
    await later(withSecond());
    expect(made).toEqual([NEW_TITLE]);
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
