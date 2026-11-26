// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import type { HermesHandoff, HermesStatus } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffsPage, HermesSection, hermesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(answers: HermesStatus[]) {
  const calls: string[] = [];
  const answer = () => answers[Math.min(calls.length, answers.length) - 1];
  const api = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return answer();
    },
    send: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return answer();
    },
  } as unknown as ApiClient;
  const root = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <HermesSection />
      </ApiContext>,
    );
  });
  return { root, calls };
}

describe("Hermes row on the Settings page", () => {
  it("shows the status from /api/hermes/status, and Reload checks again", async () => {
    const { root, calls } = await render([
      { state: "disabled" },
      { state: "incompatible", detail: "Hermes 0.24.0 is not tested", checkedAt: 1 },
    ]);
    expect(root.textContent).toContain("disabled");
    expect(root.textContent).toContain("hermes.enabled");
    const reload = [...root.querySelectorAll("button")].find((b) => b.textContent === "Reload");
    await act(async () => reload?.click());
    expect(calls).toEqual(["GET hermes/status", "POST hermes/refresh"]);
    expect(root.textContent).toContain("incompatible");
    expect(root.textContent).toContain("Hermes 0.24.0 is not tested");
  });

  it("shows a ready Hermes with its version and profile", async () => {
    const { root } = await render([
      {
        state: "ready",
        version: "0.23.3",
        url: "http://hermes-docker:8642",
        profile: "pi-spore",
        checkedAt: 1,
      },
    ]);
    expect(root.textContent).toContain("ready");
    expect(root.textContent).toContain(
      "Hermes 0.23.3 at http://hermes-docker:8642, profile pi-spore.",
    );
  });
});

const handoff = (fields: Partial<HermesHandoff>): HermesHandoff => ({
  id: "h1",
  direction: "out",
  agentId: "a1",
  workspaceId: "w1",
  projectId: "p1",
  profile: "pi-spore",
  kind: "task",
  text: "List /tmp.",
  state: "running",
  controls: [],
  createdAt: 1,
  updatedAt: 2,
  ...fields,
});

async function renderPage(handoffs: HermesHandoff[], reconcile?: unknown) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const api = {
    get: async (path: string) => (path.endsWith("/reconcile") ? reconcile : { handoffs }),
    send: async (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      return {};
    },
  } as unknown as ApiClient;
  const root = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <HandoffsPage />
      </ApiContext>,
    );
  });
  const buttons = (label: string) =>
    [...document.querySelectorAll("button")].filter((b) => b.textContent === label);
  const button = (label: string) => buttons(label)[0];
  return { root, sent, button, buttons };
}

describe("Hermes handoffs page", () => {
  it("shows the state, the times, and unknown for a blank provider and model, and cancels", async () => {
    const { root, sent, button } = await renderPage([handoff({ model: "gpt-6.1-sol" })]);
    expect(root.textContent).toContain("running");
    expect(root.textContent).toContain("Provider unknown, model gpt-6.1-sol.");
    await act(async () => button("Cancel")?.click());
    expect(sent).toEqual([{ method: "POST", path: "hermes/handoffs/h1/cancel", body: {} }]);
  });

  it("answers an open approval with once or deny only", async () => {
    const control = {
      promptId: "p1",
      kind: "approval" as const,
      command: "rm -r /tmp/x",
      state: "open" as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };
    const { root, sent, button } = await renderPage([handoff({ controls: [control] })]);
    expect(root.textContent).toContain("rm -r /tmp/x");
    expect(button("Always")).toBeUndefined();
    await act(async () => button("Allow once")?.click());
    expect(sent).toEqual([
      { method: "POST", path: "hermes/handoffs/h1/controls/p1", body: { choice: "once" } },
    ]);
  });

  it("checks what is known before it offers the picks for an uncertain handoff, and confirms Send again", async () => {
    const uncertain = handoff({ state: "uncertain" });
    const { root, sent, button, buttons } = await renderPage([uncertain], {
      handoff: uncertain,
      runStatus: "unknown",
      toolStarted: "terminal: rm -r /tmp/x",
      messages: [{ role: "user", content: "List /tmp." }],
    });
    expect(button("Mark as interrupted")).toBeUndefined();
    await act(async () => button("Check what is known")?.click());
    expect(root.textContent).toContain("Run status now: unknown");
    expect(root.textContent).toContain("Last tool started: terminal: rm -r /tmp/x");
    await act(async () => button("Send again")?.click());
    expect(document.body.textContent).toContain("The first run may have run");
    expect(sent).toEqual([]);
    await act(async () => buttons("Send again")[1]?.click());
    expect(sent).toEqual([
      {
        method: "POST",
        path: "hermes/handoffs/h1/resolve",
        body: { action: "resend", confirmed: true },
      },
    ]);
  });

  it("adds a page with no rail entry", () => {
    const pages: { path: string; rail?: unknown }[] = [];
    hermesWeb.setup({
      use: () => ({ addSection: () => undefined }),
      addPage: (page: { path: string; rail?: unknown }) => pages.push(page),
    } as never);
    expect(pages).toEqual([expect.objectContaining({ path: "/hermes" })]);
    expect(pages[0]?.rail).toBeUndefined();
  });
});
