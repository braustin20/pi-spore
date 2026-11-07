import type { ApiClient } from "@pi-spore/module-api";
import type { Inbox, InboxItem } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { createInboxStore, itemKey, notification } from "./inbox-store.js";

const workspace = { id: "w1", name: "Colors", projectName: "game", state: "active" as const };
const chat = { id: "a1", title: "Pick colors", kind: "worker" as const, active: true };

const question = (id: string, at: number): InboxItem => ({
  kind: "question",
  at,
  agentId: "a1",
  workspace,
  chat,
  question: {
    id,
    agentId: "a1",
    workspaceId: "w1",
    question: `Question ${id}?`,
    state: "open",
    createdAt: at,
  },
});

/** An API client whose `attention:inbox` subscription the test feeds by hand. */
function fakeApi() {
  let listener: ((event: unknown) => void) | undefined;
  let subscriptions = 0;
  const api = {
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      expect(topic).toBe("attention:inbox");
      subscriptions++;
      listener = onEvent;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as ApiClient;
  const send = (items: InboxItem[]) => {
    const inbox: Inbox = { items, running: [] };
    listener?.({ type: "inbox", inbox });
  };
  return { api, send, subscriptions: () => subscriptions, listening: () => listener !== undefined };
}

describe("the inbox store", () => {
  it("shares one subscription and notifies only for items that are new after the first inbox", () => {
    const fake = fakeApi();
    const notified: string[] = [];
    const store = createInboxStore(fake.api, (item) => notified.push(itemKey(item)));
    let changes = 0;
    const stopA = store.subscribe(() => changes++);
    const stopB = store.subscribe(() => changes++);
    expect(fake.subscriptions()).toBe(1);

    fake.send([question("q1", 1)]);
    expect(store.get()?.items).toHaveLength(1);
    expect(notified).toEqual([]);

    fake.send([question("q2", 2), question("q1", 1)]);
    expect(notified).toEqual(["question:q2"]);
    expect(changes).toBe(4);

    // A broken event is ignored, not shown.
    fake.send([{ kind: "nope" } as unknown as InboxItem]);
    expect(store.get()?.items).toHaveLength(2);

    stopA();
    expect(fake.listening()).toBe(true);
    stopB();
    expect(fake.listening()).toBe(false);
  });

  it("words notifications by kind", () => {
    expect(notification(question("q1", 1))).toEqual({
      title: "Question from Colors (game, Pick colors)",
      body: "Question q1?",
    });
    expect(
      notification({
        kind: "failed",
        at: 1,
        agentId: "a1",
        workspace,
        chat,
        error: "Pi exited\nmore",
      }),
    ).toEqual({ title: "Agent failed in Colors (game, Pick colors)", body: "Pi exited" });
  });
});
