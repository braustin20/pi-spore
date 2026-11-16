/// <reference types="node" />
// The service worker is a plain script for the browser, so the test runs it in a vm with one fake
// `self` and nothing else in its global scope (ADR 0187).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const code = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

const ORIGIN = "https://box.example";

interface FakeEvent {
  waitUntil(promise: Promise<unknown>): void;
  data?: { json(): unknown };
  notification?: { data?: { href?: unknown }; close(): void };
}

interface FakeWindow {
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

/** The worker script with a fake `self`, and the events it registered. */
function loadWorker(
  self: {
    registration?: { showNotification(title: string, options: unknown): Promise<unknown> };
    navigator?: { setAppBadge?: (count: number) => unknown };
    clients?: {
      matchAll(options: unknown): Promise<FakeWindow[]>;
      openWindow(url: string): unknown;
    };
    location?: { origin: string };
  } = {},
) {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const worker = {
    addEventListener: (type: string, handler: (event: FakeEvent) => void) => {
      listeners.set(type, handler);
    },
    registration: { showNotification: async () => undefined },
    navigator: {},
    clients: { matchAll: async () => [], openWindow: async () => undefined },
    location: { origin: ORIGIN },
    ...self,
  };
  runInNewContext(code, { self: worker });
  return {
    /** The event types the worker listens to. */
    types: () => [...listeners.keys()].sort(),
    /** Fires one event and returns what the worker handed to `waitUntil`. */
    fire(type: string, event: Omit<FakeEvent, "waitUntil">): Promise<unknown>[] {
      const handler = listeners.get(type);
      if (!handler) throw new Error(`the worker has no ${type} listener`);
      const waits: Promise<unknown>[] = [];
      handler({ waitUntil: (promise) => waits.push(promise), ...event });
      return waits;
    },
  };
}

const pushEvent = (payload: unknown): Omit<FakeEvent, "waitUntil"> => ({
  data: { json: () => payload },
});

const payload = {
  title: "Question from work (proj)",
  body: "Which colour?",
  href: "#/workspaces/W1/chats/C1",
  tag: "question:W1/C1",
  badge: 3,
};

const ITEM_URL = "https://box.example/#/workspaces/W1/chats/C1";

/** A window client that records the order of `focus` and `navigate`, and can fail to navigate. */
function fakeWindow(failsToNavigate = false): FakeWindow & { order: string[] } {
  const window = {
    order: [] as string[],
    focus: vi.fn(async () => {
      window.order.push("focus");
    }),
    navigate: vi.fn(async () => {
      window.order.push("navigate");
      if (failsToNavigate) throw new Error("the page is not controlled by this worker");
    }),
  };
  return window;
}

const clickEvent = (href: unknown): Omit<FakeEvent, "waitUntil"> => ({
  notification: { data: { href }, close: vi.fn() },
});

describe("the service worker", () => {
  it("listens only to push and notificationclick", () => {
    // A `fetch` listener could serve or cache the page at `/`, which holds the API token (ADR 0143).
    expect(loadWorker().types()).toEqual(["notificationclick", "push"]);
  });

  it("shows the payload's text and tag, and sets the app badge", async () => {
    const showNotification = vi.fn(async () => undefined);
    const setAppBadge = vi.fn(async () => undefined);
    const worker = loadWorker({
      registration: { showNotification },
      navigator: { setAppBadge },
    });
    await Promise.all(worker.fire("push", pushEvent(payload)));
    expect(showNotification).toHaveBeenCalledWith("Question from work (proj)", {
      body: "Which colour?",
      tag: "question:W1/C1",
      data: { href: "#/workspaces/W1/chats/C1" },
    });
    expect(setAppBadge).toHaveBeenCalledWith(3);
  });

  it("shows the notification even when the badge throws", async () => {
    const showNotification = vi.fn(async () => undefined);
    const worker = loadWorker({
      registration: { showNotification },
      navigator: {
        setAppBadge: () => {
          throw new Error("badging is off in the phone's settings");
        },
      },
    });
    await Promise.all(worker.fire("push", pushEvent(payload)));
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("shows the notification even when the badge never settles", async () => {
    const shown = Promise.resolve();
    const showNotification = vi.fn(() => shown);
    const setAppBadge = vi.fn(() => new Promise(() => {}));
    const worker = loadWorker({
      registration: { showNotification },
      navigator: { setAppBadge },
    });
    const waits = worker.fire("push", pushEvent(payload));
    // What the worker waits for is the notification alone, so a hung badge cannot hold it back.
    expect(waits).toEqual([shown]);
    await Promise.all(waits);
    expect(setAppBadge).toHaveBeenCalledWith(3);
  });

  it("shows a notification for a push with no payload", async () => {
    // iOS drops a subscription after silent pushes, so a push always shows something (ADR 0187).
    const showNotification = vi.fn(async () => undefined);
    const worker = loadWorker({ registration: { showNotification } });
    await Promise.all(worker.fire("push", {}));
    expect(showNotification).toHaveBeenCalledWith("pi-spore", {
      body: "",
      tag: undefined,
      data: { href: "" },
    });
  });

  it("shows a notification for a payload that is not JSON", async () => {
    const showNotification = vi.fn(async (_title: string, _options: unknown) => undefined);
    const worker = loadWorker({ registration: { showNotification } });
    const waits = worker.fire("push", {
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
    });
    await Promise.all(waits);
    expect(showNotification.mock.calls[0]?.[0]).toBe("pi-spore");
  });

  it("focuses an open window and navigates it to the item", async () => {
    const window = fakeWindow();
    const matchAll = vi.fn(async () => [window]);
    const openWindow = vi.fn(async () => undefined);
    const close = vi.fn();
    const worker = loadWorker({ clients: { matchAll, openWindow } });
    const event = { notification: { data: { href: payload.href }, close } };
    await Promise.all(worker.fire("notificationclick", event));
    expect(close).toHaveBeenCalled();
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(window.order).toEqual(["focus", "navigate"]);
    expect(window.navigate).toHaveBeenCalledWith(ITEM_URL);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a window when the open page cannot be navigated", async () => {
    const window = fakeWindow(true);
    const openWindow = vi.fn(async () => undefined);
    const worker = loadWorker({
      clients: { matchAll: async () => [window], openWindow },
    });
    await Promise.all(worker.fire("notificationclick", clickEvent(payload.href)));
    expect(openWindow).toHaveBeenCalledWith(ITEM_URL);
  });

  it("opens a window when no pi-spore window is open", async () => {
    const openWindow = vi.fn(async () => undefined);
    const worker = loadWorker({
      clients: { matchAll: async () => [], openWindow },
    });
    await Promise.all(worker.fire("notificationclick", clickEvent(payload.href)));
    expect(openWindow).toHaveBeenCalledWith(ITEM_URL);
  });

  it("opens the app itself for a link that is not a hash link of this app", async () => {
    const openWindow = vi.fn(async () => undefined);
    const worker = loadWorker({
      clients: { matchAll: async () => [], openWindow },
    });
    await Promise.all(worker.fire("notificationclick", clickEvent("https://evil.example")));
    expect(openWindow).toHaveBeenCalledWith("https://box.example/");
  });
});
