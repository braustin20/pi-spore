import type { AgentDialog } from "@pi-spore/shared";
import { Button, Select, Textarea } from "@pi-spore/ui";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";

export interface SlashCommand {
  name: string;
  description?: string;
}

/**
 * The message box. Enter sends, Shift+Enter adds a line. While the agent works, a message goes in as a steer
 * (after the current turn) or a follow-up (after the run). Typing `/` lists slash commands. `controls` (model and
 * thinking) sit in the row under the text.
 */
export function Composer({
  busy,
  disabled,
  loadCommands,
  controls,
  onSend,
  onAbort,
}: {
  busy: boolean;
  disabled: boolean;
  loadCommands: () => Promise<SlashCommand[]>;
  controls?: ReactNode;
  onSend: (message: string, whileBusy: "steer" | "followUp") => Promise<void>;
  onAbort: () => void;
}) {
  const [text, setText] = useState("");
  const [whileBusy, setWhileBusy] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[] | undefined>();

  const showCommands = text.startsWith("/") && !text.includes(" ") && !text.includes("\n");
  const wantCommands = showCommands && commands === undefined;
  // Load the list once, the first time the user types "/".
  useEffect(() => {
    if (!wantCommands) return;
    let current = true;
    loadCommands()
      .then((loaded) => current && setCommands(loaded))
      .catch(() => current && setCommands([]));
    return () => {
      current = false;
    };
  }, [wantCommands, loadCommands]);
  const matches = showCommands
    ? (commands ?? []).filter((command) => `/${command.name}`.startsWith(text)).slice(0, 8)
    : [];

  const send = () => {
    const message = text.trim();
    if (!message || sending || disabled) return;
    setSending(true);
    onSend(message, whileBusy)
      .then(() => setText(""))
      .finally(() => setSending(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="relative">
      {matches.length > 0 && (
        <ul className="absolute inset-x-0 bottom-full z-10 m-0 mb-1.5 list-none overflow-hidden rounded-xl border border-line bg-panel p-1">
          {matches.map((command) => (
            <li key={command.name}>
              <button
                type="button"
                onClick={() => setText(`/${command.name} `)}
                className="flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-raised"
              >
                <code className="text-accent-strong">/{command.name}</code>
                <span className="truncate text-muted">{command.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-xl border border-line bg-panel focus-within:border-muted">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message the agent"
          placeholder={
            busy
              ? "The agent is working. Your message goes in as chosen below."
              : "Message the agent"
          }
          rows={3}
          disabled={disabled}
          className="block w-full resize-none border-0 bg-transparent px-3.5 pt-3 text-[15px] focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5">
          {controls}
          <div className="flex-1" />
          {busy && (
            <Select
              value={whileBusy}
              onChange={(event) => setWhileBusy(event.target.value as "steer" | "followUp")}
              aria-label="When a message sent now goes in"
            >
              <option value="steer">Steer: after this turn</option>
              <option value="followUp">Follow up: after the run</option>
            </Select>
          )}
          {busy && (
            <Button variant="secondary" onClick={onAbort}>
              <Square />
              Stop
            </Button>
          )}
          <Button
            variant="primary"
            onClick={send}
            disabled={disabled || sending || text.trim() === ""}
          >
            <ArrowUp />
            {busy ? "Queue" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One extension dialog (R5.6): confirm, select, or a text answer. */
export function DialogCard({
  dialog,
  onAnswer,
}: {
  dialog: AgentDialog;
  onAnswer: (answer: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  return (
    <section
      aria-label={dialog.title ?? "The agent asks"}
      className="flex flex-col gap-2.5 rounded-xl border border-warn/50 bg-panel p-4"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-warn">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
        {dialog.title ?? "The agent asks"}
      </div>
      {dialog.message && <p className="m-0 text-sm whitespace-pre-wrap">{dialog.message}</p>}
      {dialog.method === "confirm" && (
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => onAnswer({ confirmed: true })}>
            Yes
          </Button>
          <Button onClick={() => onAnswer({ confirmed: false })}>No</Button>
        </div>
      )}
      {dialog.method === "select" && (
        <div className="flex flex-col gap-1.5">
          {(dialog.options ?? []).map((option, index) => (
            <button
              key={option}
              type="button"
              onClick={() => onAnswer({ value: option })}
              className="flex cursor-pointer items-baseline gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-left text-sm text-fg hover:border-accent"
            >
              <span className="font-mono text-xs text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1">{option}</span>
            </button>
          ))}
          <div>
            <Button variant="ghost" onClick={() => onAnswer({ cancelled: true })}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(dialog.method === "input" || dialog.method === "editor") && (
        <>
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={dialog.placeholder}
            aria-label="Your answer"
            rows={dialog.method === "editor" ? 8 : 2}
            className={dialog.method === "editor" ? "font-mono" : undefined}
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => onAnswer({ value })}>
              Answer
            </Button>
            <Button variant="ghost" onClick={() => onAnswer({ cancelled: true })}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
