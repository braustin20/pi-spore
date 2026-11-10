// @vitest-environment happy-dom
import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Inbox, Question } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attentionWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DialogCard = () => null;

const question = (extra: Partial<Question>): Question => ({
  id: "Q1",
  agentId: "A1",
  workspaceId: "W1",
  question: "Which colour?",
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
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

async function render(shown: Question) {
  let page: ComponentType | undefined;
  const send = vi.fn(async () => undefined);
  const api = {
    get: async () => undefined,
    send,
    subscribe: (_topic: string, listener: (event: unknown) => void) => {
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
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Home />
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
  return { choice, send, container: container as HTMLElement };
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
