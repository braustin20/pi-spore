import { Button, Menu, MenuItem, MenuLabel } from "@pi-spore/ui";
import { ChevronDown, Ellipsis } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type ChatBarProps,
  group,
  HINTS,
  ICONS,
  isWorking,
  label,
  SR_LABELS,
  TitleForm,
} from "./chats.js";

/**
 * The chat header and the chat bar in one row, so a phone keeps its height for the messages. The chats go in a
 * picker menu and the actions in a "⋯" menu.
 */
export function PhoneChatRow({
  workspaceId,
  chats,
  selected,
  canStart,
  onNew,
  onRename,
  onClose,
  chip,
  context,
  onCompact,
  canCompact,
  onStop,
  canStop,
}: ChatBarProps & {
  /** The agent's state chip, the same one the wide header shows. */
  chip: ReactNode;
  /** Text such as "context 42%", when the usage is known. */
  context: string | undefined;
  onCompact: () => void;
  canCompact: boolean;
  onStop: () => void;
  canStop: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <div className="flex shrink-0 items-center border-b border-line px-4 py-1">
        <TitleForm chat={selected} onRename={onRename} onDone={() => setRenaming(false)} />
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1">
      <Menu
        trigger={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Chats: ${label(selected)}`}
            className="min-w-0 max-w-[60%] shrink"
          >
            <span className="min-w-0 truncate">{label(selected)}</span>
            <ChevronDown />
          </Button>
        }
      >
        {chats.map((chat) => {
          const kind = group(chat);
          const Icon = ICONS[kind];
          return (
            <MenuItem
              key={chat.id}
              href={`#/workspaces/${workspaceId}/chats/${chat.id}`}
              current={chat.id === selected.id}
              title={`${label(chat)}. ${HINTS[kind]}`}
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{label(chat)}</span>
              {kind !== "worker" && <span className="sr-only">{SR_LABELS[kind]}</span>}
            </MenuItem>
          );
        })}
      </Menu>
      {/* A long state, such as a pipeline name, truncates here; it must not push Chat actions off the screen. */}
      <div className="flex min-w-0 flex-1">{chip}</div>
      <Menu
        align="end"
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="Chat actions">
            <Ellipsis />
          </Button>
        }
      >
        {context && <MenuLabel>{context}</MenuLabel>}
        <MenuItem onSelect={onCompact} disabled={!canCompact}>
          Compact
        </MenuItem>
        <MenuItem
          onSelect={onStop}
          disabled={!canStop}
          title="Stop the agent process; the chat is kept. Not while a helper runs."
        >
          Stop agent
        </MenuItem>
        <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
        <MenuItem onSelect={() => onNew("worker", false)} disabled={!canStart}>
          New chat
        </MenuItem>
        <MenuItem onSelect={() => onNew("side", false)} disabled={!canStart}>
          Side chat
        </MenuItem>
        <MenuItem onSelect={() => onNew("side", true)} disabled={!canStart}>
          With context
        </MenuItem>
        <MenuItem onSelect={() => onClose(selected)} disabled={isWorking(selected)}>
          Close this chat
        </MenuItem>
      </Menu>
    </div>
  );
}
