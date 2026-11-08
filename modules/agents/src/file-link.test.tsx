// @vitest-environment happy-dom
import type { WebHost } from "@pi-spore/module-api";
import type { ChatMessage } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MessageList } from "./messages.js";
import { agentsWeb } from "./web.js";
import { type AgentsWeb, AgentsWebKey } from "./web-contract.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reply = (text: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function show(text: string) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <MessageList agentId="a1" workspaceId="w1" messages={[reply(text)]} running={[]} />,
    );
  });
  return container;
}

describe("links to Markdown files in a message", () => {
  it("stay plain links while no module sets a file link", async () => {
    const root = await show("Read [the plan](docs/plan.md).");
    const link = root.querySelector("a");
    expect(link?.getAttribute("href")).toBe("docs/plan.md");
    expect(root.querySelector("[data-file-link]")).toBeNull();
  });

  it("render the file link component with the workspace id and the path", async () => {
    let web: AgentsWeb | undefined;
    agentsWeb.setup({
      provide: (key: unknown, impl: AgentsWeb) => {
        if (key === AgentsWebKey) web = impl;
      },
      use: () => ({ setMain: () => {}, setStatus: () => {} }),
    } as unknown as WebHost);
    web?.setFileLink(({ workspaceId, path, children }) => (
      <span data-file-link={`${workspaceId}:${path}`}>{children}</span>
    ));

    const root = await show(
      "Read [the plan](docs/PLAN.MD), [a site](https://example.com/x.md), and [notes](notes.txt).",
    );
    const linked = root.querySelectorAll("[data-file-link]");
    expect(linked).toHaveLength(1);
    expect(linked[0]?.getAttribute("data-file-link")).toBe("w1:docs/PLAN.MD");
    expect(linked[0]?.textContent).toBe("the plan");
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/x.md",
      "notes.txt",
    ]);
  });
});
