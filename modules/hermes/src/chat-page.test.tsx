// @vitest-environment happy-dom
// The Hermes chat page against a fake ApiClient. No Hermes is involved; the server side is in chat.test.ts.
import { type ApiClient, ApiContext, type WebPage } from "@pi-spore/module-api";
import type {
  HermesChatEvent,
  HermesChatRun,
  HermesChatSession,
  HermesControl,
  HermesStatus,
} from "@pi-spore/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusStore, HermesPage, STATUS_MS } from "./chat-page.js";
import { hermesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const READY: HermesStatus = {
  state: "ready",
  version: "0.23.3",
  url: "http://hermes-docker:8642",
  profile: "pi-spore",
  checkedAt: 1,
};

const SESSIONS: HermesChatSession[] = [
  { id: "s1", source: "api_server", kind: "chat", title: "Ping test" },
  {
    id: "pi-spore-h1",
    source: "api_server",
    kind: "handoff",
    title: "A handoff",
    readOnly: "A handoff session; read-only here",
  },
  { id: "cli-1", source: "cli", kind: "foreign", title: "From the CLI", readOnly: "Owned by cli" },
];

const run = (fields: Partial<HermesChatRun> = {}): HermesChatRun => ({
  id: "r1",
  sessionId: "s1",
  input: "Reply with pong.",
  state: "running",
  runId: "run_1",
  stopRequested: false,
  text: "",
  textSeq: 0,
  tools: [],
  controls: [],
  createdAt: 1,
  updatedAt: 2,
  ...fields,
});

const control = (fields: Partial<HermesControl>): HermesControl => ({
  promptId: "p1",
  kind: "approval",
  state: "open",
  createdAt: Date.now(),
  expiresAt: Date.now() + 300_000,
  ...(fields.kind === "clarify" ? {} : { command: "rm -r /tmp/x" }),
  ...fields,
});

/** A value, or a function of the full path (with its query). */
type Answer = unknown | ((path: string) => unknown);

/** A fake ApiClient: GET answers by path without its query, POSTs are recorded, topics are pushed by the test. */
function fakeApi(answers: Record<string, Answer>) {
  const gets: string[] = [];
  const sent: { method: string; path: string; body: unknown }[] = [];
  const topics = new Map<string, (event: unknown) => void>();
  const api = {
    get: async (path: string) => {
      gets.push(path);
      const key = path.split("?")[0] as string;
      if (!(key in answers)) throw new Error(`No answer for ${path}`);
      const answer = answers[key];
      return typeof answer === "function" ? (answer as (path: string) => unknown)(path) : answer;
    },
    send: async (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      return path.endsWith("/runs") ? { run: run({ id: "r9", input: "hi", state: "queued" }) } : {};
    },
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      topics.set(topic, onEvent);
      return () => topics.delete(topic);
    },
  } as unknown as ApiClient;
  const push = async (topic: string, event: HermesChatEvent) => {
    const listener = topics.get(topic);
    if (!listener) throw new Error(`Nobody listens on ${topic}`);
    await act(async () => listener(event));
  };
  return { api, gets, sent, topics, push };
}

async function render(fake: ReturnType<typeof fakeApi>, sessionId?: string) {
  const store = createStatusStore(fake.api);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ApiContext value={fake.api}>
        <HermesPage store={store} params={sessionId ? { sessionId } : {}} />
      </ApiContext>,
    );
  });
  // The status read, then the list it starts.
  await act(async () => undefined);
  return container;
}

const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter((b) => b.textContent === label);
const button = (label: string) => buttons(label)[0];
const click = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`No button ${label}`);
  await act(async () => target.click());
};
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(element: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => element.dispatchEvent(event));
  return event;
}

const chat = (messages: unknown[] = []) =>
  fakeApi({
    "hermes/status": READY,
    "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
    "hermes/chat/sessions/s1/messages": { messages },
    "hermes/handoffs": { enabled: true, handoffs: [] },
  });

function Visible({ hook }: { hook: () => boolean }) {
  return <span>{hook() ? "shown" : "hidden"}</span>;
}

describe("the Hermes page", () => {
  it("says Hermes is off, links to Settings, asks nothing more, and hides the rail entry", async () => {
    const fake = fakeApi({ "hermes/status": { state: "disabled" } });
    const page = await render(fake);
    expect(page.textContent).toContain("Hermes is off");
    expect(page.querySelector('a[href="#/settings"]')).not.toBeNull();
    expect(fake.gets).toEqual(["hermes/status"]);

    const pages: WebPage[] = [];
    hermesWeb.setup({
      api: fake.api,
      use: () => ({ addSection: () => undefined, addPanel: () => undefined }),
      addPage: (added: WebPage) => pages.push(added),
    } as never);
    expect(pages.map((added) => added.path)).toEqual(["/hermes", "/hermes/:sessionId"]);
    const hook = pages[0]?.rail?.useVisible as () => boolean;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Visible hook={hook} />));
    await act(async () => undefined);
    expect(container.textContent).toBe("hidden");
  });

  it("shows the rail entry while Hermes is on", async () => {
    const fake = fakeApi({ "hermes/status": READY });
    const pages: WebPage[] = [];
    hermesWeb.setup({
      api: fake.api,
      use: () => ({ addSection: () => undefined, addPanel: () => undefined }),
      addPage: (added: WebPage) => pages.push(added),
    } as never);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(<Visible hook={pages[0]?.rail?.useVisible as () => boolean} />),
    );
    await act(async () => undefined);
    expect(container.textContent).toBe("shown");
  });

  it("shows the profile, the status, the version, and the sessions with why some are read-only", async () => {
    const page = await render(chat());
    expect(page.textContent).toContain("Profile pi-spore");
    expect(page.textContent).toContain("ready");
    expect(page.textContent).toContain("Hermes 0.23.3");
    const rows = [...page.querySelectorAll('nav[aria-label="Hermes sessions"] a')];
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "#/hermes/s1",
      "#/hermes/pi-spore-h1",
      "#/hermes/cli-1",
    ]);
    expect(rows[1]?.textContent).toContain("handoff");
    expect(rows[1]?.textContent).toContain("A handoff session; read-only here");
    expect(rows[2]?.textContent).toContain("Owned by cli");
    expect(page.textContent).toContain("Handoffs");
  });

  it("never offers to send into a session of another source, and says why", async () => {
    const fake = chat();
    const page = await render(fake, "cli-1");
    await act(async () => undefined);
    expect(page.textContent).toContain("Read-only: Owned by cli.");
    expect(button("Send")).toBeUndefined();
    expect(page.querySelector("textarea")).toBeNull();
  });

  it("asks for a title and an optional project for a new session, and says what it is", async () => {
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: [] },
      "hermes/handoffs": { enabled: true, handoffs: [] },
      projects: {
        projects: [
          {
            id: "p1",
            name: "app",
            slug: "app",
            path: "/work/app",
            vcs: "git",
            traits: [],
            createdAt: 1,
          },
        ],
      },
    });
    const page = await render(fake);
    await click("New session");
    expect(page.textContent).toContain(
      "A new conversation with the Hermes profile pi-spore. It is not Homelab Maintainer and does not share its memory.",
    );
    expect(page.textContent).toContain("Project (optional)");
    expect(button("Create")?.disabled).toBe(true);
    await type(page.querySelector("input") as HTMLInputElement, "Ping test");
    const select = page.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "p1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Create");
    expect(fake.sent).toEqual([
      {
        method: "POST",
        path: "hermes/chat/sessions",
        body: { title: "Ping test", projectId: "p1" },
      },
    ]);
  });

  it("restores the transcript, then shows live text, tool rows, and the provider and model", async () => {
    const fake = chat([
      { id: 2, role: "assistant", content: "**pong**" },
      { id: 1, role: "user", content: "ping" },
      { id: 3, role: "session_meta" },
    ]);
    const page = await render(fake, "s1");
    await act(async () => undefined);
    expect(fake.gets).toContain("hermes/chat/sessions/s1/messages?limit=100&offset=0&order=latest");
    const text = page.textContent ?? "";
    expect(text.indexOf("ping")).toBeLessThan(text.indexOf("pong"));
    expect(page.querySelector("strong")?.textContent).toBe("pong");
    expect(text).not.toContain("session_meta");

    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [
        run({
          input: "List /tmp.",
          text: "Lis",
          tools: [{ name: "terminal", preview: "ls /tmp", state: "running" }],
        }),
      ],
    });
    await fake.push("hermes:session:s1", { type: "delta", runId: "r1", delta: "ted.", seq: 1 });
    expect(page.textContent).toContain("Listed.");
    expect(page.textContent).toContain("terminal: ls /tmp");
    expect(page.textContent).toContain("Provider unknown, model unknown.");
    expect(button("Send")?.disabled).toBe(true);

    const before = fake.gets.length;
    await fake.push("hermes:session:s1", {
      type: "run",
      run: run({ state: "completed", provider: "openai-codex", model: "gpt-6.1-sol" }),
    });
    expect(page.textContent).toContain("Provider openai-codex, model gpt-6.1-sol.");
    // The ended run is in the stored transcript now, so it is read again.
    expect(fake.gets.length).toBeGreaterThan(before);
  });

  it("sends the composer's text to the session", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    await type(page.querySelector("textarea") as HTMLTextAreaElement, "hi");
    await click("Send");
    expect(fake.sent).toEqual([
      { method: "POST", path: "hermes/chat/sessions/s1/runs", body: { text: "hi" } },
    ]);
  });

  it("sends on Enter and clears the box, and on Ctrl or Cmd+Enter too", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    const box = page.querySelector("textarea") as HTMLTextAreaElement;
    await type(box, "hi");
    expect((await press(box)).defaultPrevented).toBe(true);
    expect(fake.sent).toEqual([
      { method: "POST", path: "hermes/chat/sessions/s1/runs", body: { text: "hi" } },
    ]);
    expect(box.value).toBe("");
    // The sent run is still queued, so let it end before the next send.
    await fake.push("hermes:session:s1", {
      type: "run",
      run: run({ id: "r9", state: "completed" }),
    });
    await type(box, "again");
    await press(box, { ctrlKey: true });
    await type(box, "more");
    await fake.push("hermes:session:s1", {
      type: "run",
      run: run({ id: "r9", state: "completed" }),
    });
    await press(box, { metaKey: true });
    expect(fake.sent.map((post) => post.body)).toEqual([
      { text: "hi" },
      { text: "again" },
      { text: "more" },
    ]);
  });

  it("adds a new line on Shift+Enter, and does not send while an IME composes", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    const box = page.querySelector("textarea") as HTMLTextAreaElement;
    await type(box, "hi");
    expect((await press(box, { shiftKey: true })).defaultPrevented).toBe(false);
    expect((await press(box, { isComposing: true })).defaultPrevented).toBe(false);
    expect(fake.sent).toEqual([]);
    expect(box.value).toBe("hi");
  });

  it("does not send on Enter with blank text, or while a run is active", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    const box = page.querySelector("textarea") as HTMLTextAreaElement;
    await type(box, "  ");
    await press(box);
    expect(fake.sent).toEqual([]);
    await fake.push("hermes:session:s1", { type: "run", run: run() });
    await type(box, "hi");
    // No new line either: the run holds the session.
    expect((await press(box)).defaultPrevented).toBe(true);
    expect(fake.sent).toEqual([]);
    expect(box.value).toBe("hi");
  });

  it("stops a run, and says completed steps are not undone once it is cancelled", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [run()] });
    await click("Stop");
    expect(fake.sent).toEqual([{ method: "POST", path: "hermes/chat/runs/r1/stop", body: {} }]);
    await fake.push("hermes:session:s1", {
      type: "run",
      run: run({ state: "cancelled", stopRequested: true }),
    });
    expect(page.textContent).toContain("cancelled");
    expect(page.textContent).toContain("Steps Hermes completed are not undone.");
    expect(button("Stop")).toBeUndefined();
  });

  it("answers an inline approval with once or deny only, and a clarify with the typed text", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [
        run({
          state: "waiting_for_approval",
          controls: [
            control({}),
            control({
              promptId: "c1",
              kind: "clarify",
              question: "ping or pong?",
            }),
            control({ promptId: "p0", state: "expired", command: "rm -r /old" }),
          ],
        }),
      ],
    });
    expect(page.textContent).toContain("rm -r /tmp/x");
    expect(page.textContent).toContain("A Hermes request expired: rm -r /old");
    expect(button("Always")).toBeUndefined();
    await click("Allow once");
    await click("Deny");
    const answer = [...page.querySelectorAll("input")].find(
      (input) => input.getAttribute("aria-label") === "Answer",
    ) as HTMLInputElement;
    await type(answer, "pong");
    await click("Answer");
    expect(fake.sent).toEqual([
      { method: "POST", path: "hermes/chat/runs/r1/controls/p1", body: { choice: "once" } },
      { method: "POST", path: "hermes/chat/runs/r1/controls/p1", body: { choice: "deny" } },
      { method: "POST", path: "hermes/chat/runs/r1/controls/c1", body: { answer: "pong" } },
    ]);
  });

  it("shows Reconnecting plainly, and Retry for a post Hermes did not answer", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [run({ reconnecting: "Reconnecting: Hermes answered 503 to GET /v1/runs/run_1" })],
    });
    expect(page.textContent).toContain("Reconnecting: Hermes answered 503");
    await fake.push("hermes:session:s1", {
      type: "run",
      run: run({
        id: "r2",
        state: "sending",
        error: "Hermes did not answer",
        createdAt: Date.now(),
      }),
    });
    await click("Retry");
    expect(fake.sent).toEqual([{ method: "POST", path: "hermes/chat/runs/r2/retry", body: {} }]);
  });

  it("shows what is known about a run Hermes lost, then offers only Mark as interrupted", async () => {
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/chat/sessions/s1/messages": { messages: [] },
      "hermes/chat/runs/r1/reconcile": {
        runStatus: "unknown",
        toolStarted: "terminal: rm -r /tmp/x",
        messages: [],
      },
    });
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [run({ state: "unknown", error: "Hermes restarted during the run" })],
    });
    expect(button("Mark as interrupted")).toBeUndefined();
    await click("Check what is known");
    expect(page.textContent).toContain("Run status now: unknown");
    expect(page.textContent).toContain("Last tool started: terminal: rm -r /tmp/x");
    expect(page.textContent).toContain(
      "Hermes holds this session until the lost run is marked as interrupted.",
    );
    expect(button("Send again")).toBeUndefined();
    expect(button("Drop")).toBeUndefined();
    expect(button("Send")?.disabled).toBe(true);
    expect(fake.sent).toEqual([]);
    await click("Mark as interrupted");
    expect(fake.sent).toEqual([
      { method: "POST", path: "hermes/chat/runs/r1/resolve", body: { action: "interrupt" } },
    ]);
  });

  it("skips a delta the snapshot already holds, so no text shows twice", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [run({ text: "po", textSeq: 1 })],
    });
    await fake.push("hermes:session:s1", { type: "delta", runId: "r1", delta: "po", seq: 1 });
    await fake.push("hermes:session:s1", { type: "delta", runId: "r1", delta: "ng", seq: 2 });
    expect(page.textContent).toContain("pong");
    expect(page.textContent).not.toContain("popong");
  });

  it("reads the transcript again when a reconnect snapshot shows the run ended", async () => {
    let stored: unknown[] = [{ id: 1, role: "user", content: "ping" }];
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/chat/sessions/s1/messages": () => ({ messages: [...stored].reverse() }),
    });
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [run({ text: "po", textSeq: 1 })],
    });
    // The socket drops; the run completes meanwhile; the new socket gets a fresh snapshot.
    stored = [...stored, { id: 2, role: "assistant", content: "the reply" }];
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [run({ state: "completed" })],
    });
    await act(async () => undefined);
    expect(page.textContent).toContain("the reply");
  });

  it("shows a live run's message once when the stored transcript holds it after a reconnect", async () => {
    const input = "Reply with pong.";
    let stored: unknown[] = [];
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/chat/sessions/s1/messages": () => ({ messages: [...stored].reverse() }),
    });
    const page = await render(fake, "s1");
    const count = () => (page.textContent ?? "").split(input).length - 1;
    // Sent from this page: Hermes has not stored it yet, so the run block shows it.
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [run({ input })] });
    expect(count()).toBe(1);

    // A reload or restart while the run is live: the transcript read now holds the message.
    stored = [{ id: 1, role: "user", content: input }];
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [run({ input })] });
    await act(async () => undefined);
    expect(count()).toBe(1);

    stored = [...stored, { id: 2, role: "assistant", content: "pong" }];
    await fake.push("hermes:session:s1", { type: "run", run: run({ input, state: "completed" }) });
    await act(async () => undefined);
    expect(count()).toBe(1);
    expect(page.textContent).toContain("pong");
  });

  it("loads older messages, and keeps them when the newest page is read again", async () => {
    // 150 stored messages, ids 1 to 150; the page reads 100 at a time from the newest.
    let stored = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      role: "assistant",
      content: `message ${index + 1}`,
    }));
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/chat/sessions/s1/messages": (path: string) => {
        const query = new URLSearchParams(path.split("?")[1]);
        const offset = Number(query.get("offset"));
        const limit = Number(query.get("limit"));
        expect(query.get("order")).toBe("latest");
        return { messages: [...stored].reverse().slice(offset, offset + limit) };
      },
    });
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    expect(page.textContent).toContain("message 51");
    expect(page.textContent).not.toContain("message 50 ");
    await click("Load older");
    expect(fake.gets).toContain(
      "hermes/chat/sessions/s1/messages?limit=100&offset=100&order=latest",
    );
    const text = () => page.textContent ?? "";
    expect(text()).toContain("message 1");
    expect(text().indexOf("message 50")).toBeLessThan(text().indexOf("message 51"));
    // A run ends: the newest page is read again, and the older pages stay.
    stored = [...stored, { id: 151, role: "assistant", content: "message 151" }];
    await fake.push("hermes:session:s1", { type: "run", run: run({ state: "completed" }) });
    await act(async () => undefined);
    expect(text()).toContain("message 151");
    expect(text()).toContain("message 1");
    expect(page.querySelectorAll(".md").length).toBe(151);
  });

  it("asks before a Retry 24 h or more after the first try, and sends the confirm", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", {
      type: "snapshot",
      runs: [
        run({
          state: "sending",
          error: "Hermes did not answer",
          createdAt: Date.now() - 25 * 3_600_000,
        }),
      ],
    });
    await click("Retry");
    expect(page.ownerDocument.body.textContent).toContain("Its side effects would happen twice.");
    expect(fake.sent).toEqual([]);
    await act(async () => buttons("Retry")[1]?.click());
    expect(fake.sent).toEqual([
      { method: "POST", path: "hermes/chat/runs/r1/retry", body: { confirmed: true } },
    ]);
  });

  it("fills the gap when more than a page of messages came in during a reconnect", async () => {
    let stored = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      role: "assistant",
      content: `message ${index + 1}`,
    }));
    const fake = fakeApi({
      "hermes/status": READY,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/chat/sessions/s1/messages": (path: string) => {
        const query = new URLSearchParams(path.split("?")[1]);
        const offset = Number(query.get("offset"));
        return {
          messages: [...stored].reverse().slice(offset, offset + Number(query.get("limit"))),
        };
      },
    });
    const page = await render(fake, "s1");
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    await act(async () => undefined);
    expect(page.querySelectorAll(".md").length).toBe(100);
    // The socket drops; 200 messages come in; the new socket gets a fresh snapshot.
    stored = [
      ...stored,
      ...Array.from({ length: 200 }, (_, index) => ({
        id: index + 151,
        role: "assistant",
        content: `message ${index + 151}`,
      })),
    ];
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [] });
    await act(async () => undefined);
    expect(page.querySelectorAll(".md").length).toBe(300);
    await click("Load older");
    const shown = [...page.querySelectorAll(".md")].map((entry) => entry.textContent);
    expect(shown).toHaveLength(350);
    expect(new Set(shown).size).toBe(350);
    expect(shown[0]).toBe("message 1");
    expect(shown.at(-1)).toBe("message 350");
    expect(button("Load older")).toBeUndefined();
  });

  it("keeps the user's text on the page when Hermes never got it", async () => {
    const fake = chat();
    const page = await render(fake, "s1");
    const { runId: _never, ...unsent } = run({
      state: "failed",
      input: "Please list /tmp.",
      error: "Hermes is unreachable: no answer",
    });
    await fake.push("hermes:session:s1", { type: "snapshot", runs: [unsent] });
    expect(page.textContent).toContain("Please list /tmp.");
    expect(page.textContent).toContain("Hermes is unreachable: no answer");
  });

  it("shows a down Hermes plainly, and loads the sessions without a reload once it is back", async () => {
    vi.useFakeTimers();
    let status: HermesStatus = {
      state: "unreachable",
      detail: "Hermes at http://hermes-docker:8642 did not answer GET /health: ECONNREFUSED",
      checkedAt: 1,
    };
    const fake = fakeApi({
      "hermes/status": () => status,
      "hermes/chat/sessions": { enabled: true, sessions: SESSIONS },
      "hermes/handoffs": { enabled: true, handoffs: [] },
    });
    const page = await render(fake);
    expect(page.textContent).toContain("unreachable");
    expect(page.textContent).toContain("ECONNREFUSED");
    expect(fake.gets).not.toContain("hermes/chat/sessions");
    status = READY;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_MS);
    });
    expect(fake.gets).toContain("hermes/chat/sessions");
    expect(page.textContent).toContain("Ping test");
  });
});
