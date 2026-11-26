// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import type { HermesHandoff, HermesStatus, Workspace } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Handoffs, HermesPanel, REFRESH_MS } from "./handoffs-page.js";
import { HermesSection } from "./web.js";

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

const workspace = (id: string, name: string) => ({
  id,
  projectId: "p1",
  name,
  slug: name.toLowerCase(),
  isolation: "in-place",
  path: `/tmp/${name}`,
  state: "active",
  planner: false,
  createdAt: 1,
  updatedAt: 1,
});
const project = {
  id: "p1",
  name: "App",
  slug: "app",
  path: "/tmp/app",
  vcs: "folder",
  traits: [],
  createdAt: 1,
};

async function renderPage(handoffs: HermesHandoff[], reconcile?: unknown, enabled = true) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const api = {
    get: async (path: string) =>
      path.endsWith("/reconcile")
        ? reconcile
        : path === "workspaces"
          ? { workspaces: [workspace("w1", "Alpha"), workspace("w2", "Beta")] }
          : path === "projects"
            ? { projects: [project] }
            : { enabled, handoffs },
    send: async (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      return {};
    },
  } as unknown as ApiClient;
  const root = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <Handoffs />
      </ApiContext>,
    );
  });
  const buttons = (label: string) =>
    [...document.querySelectorAll("button")].filter((b) => b.textContent === label);
  const button = (label: string) => buttons(label)[0];
  return { root, sent, button, buttons };
}

describe("Hermes handoffs on the Hermes page", () => {
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

  it("answers a clarify question with the typed text", async () => {
    const control = {
      promptId: "c1",
      kind: "clarify" as const,
      question: "ping or pong?",
      state: "open" as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };
    const { root, sent, button } = await renderPage([handoff({ controls: [control] })]);
    expect(root.textContent).toContain("ping or pong?");
    const input = root.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "pong",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Answer")?.click());
    expect(sent).toEqual([
      { method: "POST", path: "hermes/handoffs/h1/controls/c1", body: { answer: "pong" } },
    ]);
  });

  it("offers Accept and Decline with a reason on a request from Hermes, beside its target, and no Cancel", async () => {
    const request = (id: string, workspaceId: string, requestId: string) => {
      const { agentId: _none, ...fields } = handoff({
        id,
        workspaceId,
        direction: "in",
        requestId,
        title: "Fix the build",
        state: "pending",
      });
      return fields;
    };
    const { root, sent, buttons } = await renderPage([
      request("h1", "w1", "r-1"),
      request("h2", "w2", "r-2"),
    ]);
    // Two requests alike but for their targets: each panel names its own, where its buttons are.
    const panels = [...root.querySelectorAll("button")]
      .filter((b) => b.textContent === "Accept")
      .map((b) => b.closest("section, div.flex.flex-col")?.textContent ?? "");
    expect(panels[0]).toContain("For App / Alpha, from the Hermes profile pi-spore, request r-1.");
    expect(panels[1]).toContain("For App / Beta, from the Hermes profile pi-spore, request r-2.");
    expect(panels[0]).not.toContain("Beta");
    expect(buttons("Cancel")).toEqual([]);
    await act(async () => buttons("Accept")[1]?.click());
    const reason = root.querySelector('input[aria-label="Reason to decline"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        reason,
        "not now",
      );
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttons("Decline")[0]?.click());
    expect(sent).toEqual([
      { method: "POST", path: "hermes/handoffs/h2/accept", body: {} },
      { method: "POST", path: "hermes/handoffs/h1/decline", body: { reason: "not now" } },
    ]);
  });

  it("says Hermes is offline on a pending handoff that waits for it", async () => {
    const { root } = await renderPage([
      handoff({ state: "pending", error: "Hermes is offline: no answer" }),
    ]);
    expect(root.textContent).toContain("Hermes is offline: no answer");
  });

  it("shows only that Hermes is off, with a link to Settings, when hermes.enabled is off", async () => {
    const { root } = await renderPage([], undefined, false);
    expect(root.textContent).toContain("Hermes is off");
    expect(root.querySelector('a[href="#/settings"]')).not.toBeNull();
    expect(root.textContent).not.toContain("No Hermes handoffs yet");
  });
});

describe("Hermes handoffs in the workspace Details column", () => {
  const workspace = { id: "w1" } as Workspace;
  async function renderPanel(...answers: HermesHandoff[][]) {
    const paths: string[] = [];
    let loaded = 0;
    const api = {
      get: async (path: string) => {
        paths.push(path);
        return { enabled: true, handoffs: answers[Math.min(paths.length, answers.length) - 1] };
      },
    } as unknown as ApiClient;
    const root = document.body.appendChild(document.createElement("div"));
    await act(async () => {
      createRoot(root).render(
        <ApiContext value={api}>
          <HermesPanel workspace={workspace} onLoaded={() => (loaded += 1)} />
        </ApiContext>,
      );
    });
    return { root, paths, loaded: () => loaded };
  }

  it("lists the workspace's handoffs and links to the Hermes handoffs page", async () => {
    const { root, paths, loaded } = await renderPanel([
      handoff({ title: "tmp", state: "running" }),
    ]);
    expect(paths).toEqual(["hermes/handoffs?workspaceId=w1"]);
    expect(root.textContent).toContain("Hermes handoffs");
    expect(root.textContent).toContain("running");
    expect(root.textContent).toContain("tmp");
    expect(root.querySelector('a[href="#/hermes"]')).not.toBeNull();
    expect(loaded()).toBe(1);
  });

  it("appears without a reload when the chat asks Hermes while Details is open", async () => {
    vi.useFakeTimers();
    try {
      const { root, paths } = await renderPanel([], [handoff({ title: "tmp", state: "pending" })]);
      expect(root.textContent).toBe("");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_MS);
      });
      expect(paths).toHaveLength(2);
      expect(root.textContent).toContain("pending");
      expect(root.querySelector('a[href="#/hermes"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing for a workspace that never asked Hermes", async () => {
    const { root, loaded } = await renderPanel([]);
    expect(root.textContent).toBe("");
    expect(loaded()).toBe(1);
  });
});
