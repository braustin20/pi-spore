import type { Agent } from "@pi-spore/shared";
import { Button, cn, Input, Tooltip } from "@pi-spore/ui";
import { Eye, History, MessageSquare, MessageSquarePlus, Pencil, Workflow, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

export const label = (chat: Agent) => chat.title ?? "New chat";

export const ICONS = { worker: MessageSquare, side: Eye, stage: Workflow, older: History } as const;

export const group = (chat: Agent) => {
  if (chat.kind === "side") return "side";
  if (chat.kind === "stage") return "stage";
  return chat.active ? "worker" : "older";
};

export const HINTS = {
  worker: "Orchestrator chat: the one chat that can change files",
  side: "Side chat: read-only",
  stage: "Pipeline stage agent",
  older: "Older orchestrator chat: read-only history",
} as const;

/** A chat that runs or waits for a slot; it must be aborted or stopped before it can close. */
export const isWorking = (chat: Agent) => ["busy", "starting", "waiting"].includes(chat.status);

export const SR_LABELS = {
  side: "(side chat)",
  stage: "(pipeline stage)",
  older: "(older, read-only)",
} as const;

/** The form that renames a chat. Escape or Cancel ends it without a change. */
export function TitleForm({
  chat,
  onRename,
  onDone,
}: {
  chat: Agent;
  onRename: (title: string) => Promise<void>;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(chat.title ?? "");
  const save = (event: FormEvent) => {
    event.preventDefault();
    const title = editing.trim();
    if (!title) return;
    void onRename(title).then(onDone);
  };
  return (
    <form onSubmit={save} className="flex items-center gap-1.5 max-md:w-full">
      <Input
        value={editing}
        onChange={(event) => setEditing(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onDone()}
        aria-label="Chat title"
        maxLength={120}
        className="w-56 max-md:min-w-0 max-md:flex-1"
        autoFocus
      />
      <Button size="sm" type="submit" disabled={!editing.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/** The chat's title, with a pencil that turns it into a text field. */
function Title({ chat, onRename }: { chat: Agent; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <TitleForm chat={chat} onRename={onRename} onDone={() => setEditing(false)} />;
  }
  return (
    <Tooltip label="Rename this chat" side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rename this chat"
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
    </Tooltip>
  );
}

/**
 * The workspace's chats as a row of links (ADR 0030): the active worker chat, then side chats, then older worker
 * chats, in the server's order. Buttons start a fresh worker chat or a side chat, empty or with the worker's context.
 */
export type ChatBarProps = {
  workspaceId: string;
  chats: readonly Agent[];
  selected: Agent;
  /** False while the workspace is parked or archived. */
  canStart: boolean;
  onNew: (kind: "worker" | "side", fork: boolean) => void;
  onRename: (title: string) => Promise<void>;
  /** Closes a chat for good (ADR 0110). */
  onClose: (chat: Agent) => void;
};

export function ChatBar({
  workspaceId,
  chats,
  selected,
  canStart,
  onNew,
  onRename,
  onClose,
}: ChatBarProps) {
  // A link (from the Pipeline panel, say) can select a tab that is off screen.
  const currentTab = useRef<HTMLAnchorElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the selected chat changes.
  useEffect(() => {
    currentTab.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected.id]);
  // On a phone the tabs take the first line and the buttons wrap onto a second one.
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 max-md:h-auto max-md:flex-wrap max-md:py-1">
      <nav aria-label="Chats" className="relative min-w-0 flex-1 overflow-x-auto max-md:basis-full">
        <ul className="m-0 flex list-none items-center gap-1 p-0">
          {chats.map((chat) => {
            const kind = group(chat);
            const Icon = ICONS[kind];
            const current = chat.id === selected.id;
            const working = isWorking(chat);
            return (
              <li
                key={chat.id}
                className={cn(
                  "flex shrink-0 items-center rounded-md text-sm hover:bg-raised/60",
                  current ? "bg-raised text-fg" : "text-muted",
                  kind === "older" && !current && "opacity-70",
                )}
              >
                <a
                  ref={current ? currentTab : undefined}
                  href={`#/workspaces/${workspaceId}/chats/${chat.id}`}
                  aria-current={current ? "page" : undefined}
                  title={`${label(chat)}. ${HINTS[kind]}`}
                  className="flex max-w-52 items-center gap-1.5 py-1 pl-2 text-inherit no-underline max-md:min-h-11"
                >
                  <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{label(chat)}</span>
                  {kind !== "worker" && <span className="sr-only">{SR_LABELS[kind]}</span>}
                  {working && (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-run animate-pulse"
                      />
                      <span className="sr-only">working</span>
                    </>
                  )}
                </a>
                <Tooltip
                  label={
                    working ? "Abort or stop this chat before you close it" : "Close this chat"
                  }
                  side="bottom"
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Close chat ${label(chat)}`}
                    disabled={working}
                    onClick={() => onClose(chat)}
                  >
                    <X />
                  </Button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </nav>
      <Title key={selected.id} chat={selected} onRename={onRename} />
      <Tooltip
        label="Start a fresh orchestrator chat. The current one stops and stays readable."
        side="bottom"
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={!canStart}
          onClick={() => onNew("worker", false)}
        >
          <MessageSquarePlus />
          <span className="max-md:sr-only">New chat</span>
        </Button>
      </Tooltip>
      <Tooltip label="A read-only chat next to the orchestrator, started empty" side="bottom">
        <Button size="sm" variant="ghost" disabled={!canStart} onClick={() => onNew("side", false)}>
          <Eye />
          <span className="max-md:sr-only">Side chat</span>
        </Button>
      </Tooltip>
      <Tooltip
        label="A read-only chat that starts with a copy of the orchestrator chat's context"
        side="bottom"
      >
        <Button size="sm" variant="ghost" disabled={!canStart} onClick={() => onNew("side", true)}>
          {/* Phones: short labels keep the chat buttons on one line under the tabs. */}
          <span className="max-md:hidden">Side chat with context</span>
          <span className="md:hidden">With context</span>
        </Button>
      </Tooltip>
    </div>
  );
}
