import type { Agent } from "@pi-spore/shared";
import { Button, cn, Input, Tooltip } from "@pi-spore/ui";
import { Eye, History, MessageSquare, MessageSquarePlus, Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";

const label = (chat: Agent) => chat.title ?? "New chat";

const ICONS = { worker: MessageSquare, side: Eye, older: History } as const;

const group = (chat: Agent) => {
  if (chat.kind === "side") return "side";
  return chat.active ? "worker" : "older";
};

const HINTS = {
  worker: "Worker chat: the one chat that can change files",
  side: "Side chat: read-only",
  older: "Older worker chat: read-only history",
} as const;

/** The chat's title, with a pencil that turns it into a text field. */
function Title({ chat, onRename }: { chat: Agent; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | undefined>();
  if (editing === undefined) {
    return (
      <Tooltip label="Rename this chat" side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Rename this chat"
          onClick={() => setEditing(chat.title ?? "")}
        >
          <Pencil />
        </Button>
      </Tooltip>
    );
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    const title = editing.trim();
    if (!title) return;
    void onRename(title).then(() => setEditing(undefined));
  };
  return (
    <form onSubmit={save} className="flex items-center gap-1.5">
      <Input
        value={editing}
        onChange={(event) => setEditing(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setEditing(undefined)}
        aria-label="Chat title"
        maxLength={120}
        className="w-56"
        autoFocus
      />
      <Button size="sm" type="submit" disabled={!editing.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The workspace's chats as a row of links (ADR 0030): the active worker chat, then side chats, then older worker
 * chats, in the server's order. Buttons start a fresh worker chat or a side chat, empty or with the worker's context.
 */
export function ChatBar({
  workspaceId,
  chats,
  selected,
  canStart,
  onNew,
  onRename,
}: {
  workspaceId: string;
  chats: readonly Agent[];
  selected: Agent;
  /** False while the workspace is parked or archived. */
  canStart: boolean;
  onNew: (kind: "worker" | "side", fork: boolean) => void;
  onRename: (title: string) => Promise<void>;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
      <nav aria-label="Chats" className="min-w-0 flex-1 overflow-x-auto">
        <ul className="m-0 flex list-none items-center gap-1 p-0">
          {chats.map((chat) => {
            const kind = group(chat);
            const Icon = ICONS[kind];
            const current = chat.id === selected.id;
            return (
              <li key={chat.id} className="shrink-0">
                <a
                  href={`#/workspaces/${workspaceId}/chats/${chat.id}`}
                  aria-current={current ? "page" : undefined}
                  title={`${label(chat)}. ${HINTS[kind]}`}
                  className={cn(
                    "flex max-w-52 items-center gap-1.5 rounded-md px-2 py-1 text-sm no-underline hover:bg-raised/60",
                    current ? "bg-raised text-fg" : "text-muted",
                    kind === "older" && !current && "opacity-70",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{label(chat)}</span>
                  {kind !== "worker" && (
                    <span className="sr-only">
                      {kind === "side" ? "(side chat)" : "(older, read-only)"}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <Title key={selected.id} chat={selected} onRename={onRename} />
      <Tooltip
        label="Start a fresh worker chat. The current one stops and stays readable."
        side="bottom"
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={!canStart}
          onClick={() => onNew("worker", false)}
        >
          <MessageSquarePlus />
          New chat
        </Button>
      </Tooltip>
      <Tooltip label="A read-only chat next to the worker, started empty" side="bottom">
        <Button size="sm" variant="ghost" disabled={!canStart} onClick={() => onNew("side", false)}>
          <Eye />
          Side chat
        </Button>
      </Tooltip>
      <Tooltip
        label="A read-only chat that starts with a copy of the worker chat's context"
        side="bottom"
      >
        <Button size="sm" variant="ghost" disabled={!canStart} onClick={() => onNew("side", true)}>
          Side chat with context
        </Button>
      </Tooltip>
    </div>
  );
}
