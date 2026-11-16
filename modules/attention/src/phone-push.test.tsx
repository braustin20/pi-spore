// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import { PHONE_QUERY } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhonePushButton } from "./phone-push.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STANDALONE_QUERY = "(display-mode: standalone)";
const ENDPOINT = "https://push.example/s/1";
/** A 65 byte P-256 key in base64url, as `GET attention/push/key` answers it. */
const PUBLIC_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A";
const KEYS = { p256dh: "the-p256dh-key", auth: "the-auth-key" };

/** What the component hands `pushManager.subscribe`. */
interface SubscribeOptions {
  userVisibleOnly: boolean;
  applicationServerKey: Uint8Array;
}

interface FakeSubscription {
  endpoint: string;
  toJSON(): { endpoint: string; keys: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

function fakeSubscription(keys: Record<string, string> = KEYS): FakeSubscription {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** The phone's push platform: permission, a service worker registration, and maybe a subscription. */
function stubPhone({
  phone = true,
  standalone = true,
  permission = "default",
  grant = permission,
  subscription,
  subscribeKeys,
  subscribeFails = false,
}: {
  phone?: boolean;
  standalone?: boolean;
  /** The permission the browser reports on load. */
  permission?: NotificationPermission;
  /** What the tap on Turn on gets. */
  grant?: NotificationPermission;
  subscription?: FakeSubscription;
  /** What the phone's new subscription reports as its keys. */
  subscribeKeys?: Record<string, string>;
  subscribeFails?: boolean;
} = {}) {
  /** The order of the platform calls, to show permission came from the tap alone. */
  const order: string[] = [];
  const subscribe = vi.fn(async (_options: SubscribeOptions) => {
    order.push("subscribe");
    if (subscribeFails) throw new Error("the phone refused the subscription");
    return fakeSubscription(subscribeKeys);
  });
  const getSubscription = vi.fn(async () => subscription ?? null);
  const registration = { pushManager: { getSubscription, subscribe } };
  const serviceWorker = {
    getRegistration: vi.fn(async () => registration),
    register: vi.fn(async () => {
      order.push("register");
      return registration;
    }),
    ready: Promise.resolve(registration),
  };
  vi.stubGlobal("navigator", { serviceWorker, standalone });
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      order.push("requestPermission");
      return grant;
    }),
  };
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("PushManager", class {});
  stubScreen(phone, standalone);
  return { order, serviceWorker, subscribe, getSubscription, notification };
}

function stubScreen(phone: boolean, standalone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY ? phone : query === STANDALONE_QUERY && standalone,
    addEventListener() {},
    removeEventListener() {},
  }));
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The button on a phone as `stubPhone` describes it, with a fake API. */
async function renderButton(
  platform: ReturnType<typeof stubPhone> = stubPhone(),
  { sendFails = false }: { sendFails?: boolean } = {},
) {
  const send = vi.fn(async () => {
    if (sendFails) throw new Error("the server refused the subscription");
    return {};
  });
  const get = vi.fn(async () => ({ publicKey: PUBLIC_KEY }));
  const api = { get, send } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <ApiContext value={api}>
        <PhonePushButton />
      </ApiContext>,
    );
  });
  const shown = container as HTMLElement;
  const button = (name: string) => {
    const found = [...shown.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!found) throw new Error(`no button ${name}`);
    return found;
  };
  /** Taps a button and lets every platform promise the component waits on settle. */
  const click = async (name: string) => {
    await act(async () => button(name).click());
    await act(async () => {});
  };
  return { container: shown, button, click, send, get, ...platform };
}

const textOf = (element: HTMLElement) => element.textContent ?? "";

describe("the phone push button", () => {
  it("renders nothing in a Safari tab on a phone, where iOS has no push", async () => {
    const { container, getSubscription } = await renderButton(stubPhone({ standalone: false }));
    expect(textOf(container)).toBe("");
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("renders nothing on a desktop browser, which has its own notification button", async () => {
    const { container, getSubscription } = await renderButton(stubPhone({ phone: false }));
    expect(textOf(container)).toBe("");
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("renders nothing on a browser with no service worker", async () => {
    const platform = stubPhone();
    vi.stubGlobal("navigator", { standalone: true });
    const { container, getSubscription } = await renderButton(platform);
    expect(textOf(container)).toBe("");
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("asks for permission before it registers anything", async () => {
    const { container, click, order, serviceWorker, send } = await renderButton(
      stubPhone({ grant: "denied" }),
    );
    await click("Turn on notifications");
    // iOS asks only from the tap: permission is the first call, and nothing comes after it.
    expect(order).toEqual(["requestPermission"]);
    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(textOf(container)).toContain("Notifications blocked");
  });

  it("shows the blocked chip when the browser already refuses notifications", async () => {
    const { container } = await renderButton(stubPhone({ permission: "denied" }));
    expect(textOf(container)).toContain("Notifications blocked");
    expect(textOf(container)).not.toContain("Turn on notifications");
  });

  it("subscribes and sends the subscription, then shows that notifications are on", async () => {
    const { container, click, send, get, subscribe } = await renderButton(
      stubPhone({ permission: "granted" }),
    );
    await click("Turn on notifications");
    expect(get).toHaveBeenCalledWith("attention/push/key");
    expect(subscribe).toHaveBeenCalledTimes(1);
    const options = subscribe.mock.calls[0]?.[0];
    if (!options) throw new Error("the component never subscribed");
    // iOS refuses a silent push, so every push must be visible (ADR 0187).
    expect(options.userVisibleOnly).toBe(true);
    expect(Buffer.from(options.applicationServerKey).toString("base64url")).toBe(PUBLIC_KEY);
    expect(send).toHaveBeenCalledWith("POST", "attention/push/subscriptions", {
      endpoint: ENDPOINT,
      keys: KEYS,
    });
    expect(textOf(container)).toContain("Notifications are on");
    expect(textOf(container)).not.toContain("Turn on notifications");
  });

  it("shows an error text when the phone refuses the subscription", async () => {
    const { container, click, send } = await renderButton(
      stubPhone({ permission: "granted", subscribeFails: true }),
    );
    await click("Turn on notifications");
    expect(send).not.toHaveBeenCalled();
    expect(textOf(container)).toContain("Turn on notifications");
    expect(textOf(container)).toContain("the phone refused the subscription");
  });

  it("keeps a subscription the phone already has and sends it again", async () => {
    const { container, send } = await renderButton(stubPhone({ subscription: fakeSubscription() }));
    expect(textOf(container)).toContain("Notifications are on");
    // Sending again is idempotent, so a server that lost the row gets it back.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("POST", "attention/push/subscriptions", {
      endpoint: ENDPOINT,
      keys: KEYS,
    });
  });

  it("shows an error text when the phone gives a subscription with no keys", async () => {
    const { container, click, send } = await renderButton(
      stubPhone({ permission: "granted", subscribeKeys: {} }),
    );
    await click("Turn on notifications");
    // A subscription the server would refuse is not push: it must not be sent or claimed as on.
    expect(send).not.toHaveBeenCalled();
    expect(textOf(container)).toContain("push subscription");
    expect(textOf(container)).toContain("Turn on notifications");
  });

  it("shows an error text when the server will not take the stored subscription back", async () => {
    // The phone keeps its subscription across a server restart, so the POST on load is how a server
    // that lost the row gets it back (ADR 0187). If that fails there is no push, and Home must say so.
    const { container, send } = await renderButton(
      stubPhone({ subscription: fakeSubscription() }),
      { sendFails: true },
    );
    expect(send).toHaveBeenCalledWith("POST", "attention/push/subscriptions", {
      endpoint: ENDPOINT,
      keys: KEYS,
    });
    expect(textOf(container)).toContain("the server refused the subscription");
    expect(textOf(container)).toContain("Turn on notifications");
  });

  it("unsubscribes the phone and deletes the subscription on Turn off", async () => {
    const subscription = fakeSubscription();
    const { container, click, send } = await renderButton(stubPhone({ subscription }));
    await click("Turn off");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith("DELETE", "attention/push/subscriptions", {
      endpoint: ENDPOINT,
    });
    expect(textOf(container)).toContain("Turn on notifications");
    expect(textOf(container)).not.toContain("Notifications are on");
  });
});
