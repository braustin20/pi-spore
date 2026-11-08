import type { ApiClient } from "@pi-spore/module-api";
import type { Inbox, InboxItem } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { chatAsks, chatWaits, createInboxStore, itemKey, notification } from "./inbox-store.js";

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
    const inbox: Inbox = { items, interrupted: [], running: [] };
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

describe("chatAsks", () => {
  const approval = (id: string, agentId: string, at: number): InboxItem => ({
    kind: "approval",
    at,
    agentId,
    workspace,
    chat: { ...chat, id: agentId },
    approval: {
      id,
      kind: "card-start",
      agentId,
      workspaceId: "w1",
      title: "Start a card",
      reason: "Because",
      subject: {},
      state: "open",
      createdAt: at,
    },
  });

  it("returns the open questions and approvals of one chat, in inbox order, and nothing else", () => {
    const items: InboxItem[] = [
      question("q2", 5),
      approval("p9", "a2", 4),
      approval("p1", "a1", 3),
      { kind: "failed", at: 3, agentId: "a1", workspace, chat, error: "boom" },
      { kind: "finished", at: 2, agentId: "a1", workspace, chat },
      question("q1", 1),
    ];
    expect(chatAsks({ items, interrupted: [], running: [] }, "a1").map(itemKey)).toEqual([
      "question:q2",
      "approval:p1",
      "question:q1",
    ]);
  });

  it("returns nothing before the first inbox", () => {
    expect(chatAsks(undefined, "a1")).toEqual([]);
  });
});

describe("chatWaits", () => {
  it("names, per chat, why it waits for the user: its newest open question, approval, or dialog", () => {
    const items: InboxItem[] = [
      { kind: "finished", at: 9, agentId: "a3", workspace, chat: { ...chat, id: "a3" } },
      {
        kind: "failed",
        at: 8,
        agentId: "a4",
        workspace,
        chat: { ...chat, id: "a4" },
        error: "boom",
      },
      {
        kind: "dialog",
        at: 7,
        agentId: "a2",
        workspace,
        chat: { ...chat, id: "a2" },
        dialog: { id: "d1", method: "confirm" },
      },
      question("q2", 5),
      question("q1", 1),
    ];
    expect(chatWaits({ items, interrupted: [], running: [] })).toEqual(
      new Map([
        ["a2", "dialog"],
        ["a1", "question"],
      ]),
    );
  });

  it("is empty before the first inbox and once everything is answered", () => {
    expect(chatWaits(undefined).size).toBe(0);
    expect(chatWaits({ items: [], interrupted: [], running: [] }).size).toBe(0);
  });
});
