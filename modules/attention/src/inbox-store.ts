import type { UserWait } from "@pi-spore/mod-agents/web";
import type { ApiClient } from "@pi-spore/module-api";
import { type Inbox, InboxEvent, type InboxItem, parse } from "@pi-spore/shared";

/** One key per thing that needs the user, stable across inbox updates. */
export function itemKey(item: InboxItem): string {
  switch (item.kind) {
    case "question":
      return `question:${item.question.id}`;
    case "approval":
      return `approval:${item.approval.id}`;
    case "dialog":
      return `dialog:${item.agentId}:${item.dialog.id}`;
    case "notice":
      return `notice:${item.source}:${item.id}`;
    default:
      return `${item.kind}:${item.agentId}:${item.at}`;
  }
}

/** The title and body of a desktop notification for an item (R15.2). */
export function notification(item: InboxItem): { title: string; body: string } {
  if (item.kind === "notice") return { title: item.title, body: item.detail ?? "" };
  const chat = item.chat.title ? `, ${item.chat.title}` : "";
  const where = `${item.workspace.name} (${item.workspace.projectName}${chat})`;
  switch (item.kind) {
    case "question":
      return { title: `Question from ${where}`, body: item.question.question };
    case "approval":
      return { title: `${where} asks for approval`, body: item.approval.title };
    case "dialog":
      return {
        title: `${where} asks`,
        body: item.dialog.title ?? item.dialog.message ?? "An extension dialog is open",
      };
    case "failed":
      return { title: `Agent failed in ${where}`, body: item.error.split("\n")[0] ?? "" };
    case "finished":
      return { title: `${where} is done`, body: "The agent finished and waits for you." };
  }
}

/** Items in `inbox` whose keys are not in `seen`. */
export function newItems(seen: ReadonlySet<string>, inbox: Inbox): InboxItem[] {
  return inbox.items.filter((item) => !seen.has(itemKey(item)));
}

/** The open questions and approvals of one chat, in inbox order. The chat page shows these above its composer. */
export function chatAsks(
  inbox: Inbox | undefined,
  chatId: string,
): Extract<InboxItem, { kind: "question" | "approval" }>[] {
  return (inbox?.items ?? []).filter(
    (item): item is Extract<InboxItem, { kind: "question" | "approval" }> =>
      (item.kind === "question" || item.kind === "approval") && item.chat.id === chatId,
  );
}

/** Why each chat waits for the user. The first item for a chat wins, so the newest. */
export function chatWaits(inbox: Inbox | undefined): Map<string, UserWait> {
  const waits = new Map<string, UserWait>();
  for (const item of inbox?.items ?? []) {
    if (item.kind !== "question" && item.kind !== "approval" && item.kind !== "dialog") continue;
    if (!waits.has(item.chat.id)) waits.set(item.chat.id, item.kind);
  }
  return waits;
}

export interface InboxStore {
  subscribe(listener: () => void): () => void;
  /** The latest inbox, or undefined before the first one arrives. */
  get(): Inbox | undefined;
}

/**
 * One subscription to `attention:inbox` for the whole page, shared by the rail badge and Home. It also shows a
 * desktop notification for each new item while the page is open but not in focus, if the user allowed it.
 */
export function createInboxStore(api: ApiClient, notify: (item: InboxItem) => void): InboxStore {
  let inbox: Inbox | undefined;
  let seen: Set<string> | undefined;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;

  const onEvent = (raw: unknown) => {
    let event: InboxEvent;
    try {
      event = parse(InboxEvent, raw, "inbox event");
    } catch (error) {
      console.error(`pi-spore: ${(error as Error).message}`);
      return;
    }
    // The first inbox after load is what was already there, not news.
    if (seen) for (const item of newItems(seen, event.inbox)) notify(item);
    seen = new Set(event.inbox.items.map(itemKey));
    inbox = event.inbox;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      unsubscribe ??= api.subscribe("attention:inbox", onEvent);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    get: () => inbox,
  };
}
