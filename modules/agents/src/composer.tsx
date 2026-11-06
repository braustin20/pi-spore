import type { AgentDialog } from "@pi-spore/shared";
import { type KeyboardEvent, useEffect, useState } from "react";

export interface SlashCommand {
  name: string;
  description?: string;
}

/**
 * The message box. Enter sends, Shift+Enter adds a line. While the agent works, a message goes in as a steer
 * (after the current turn) or a follow-up (after the run). Typing `/` lists slash commands.
 */
export function Composer({
  busy,
  disabled,
  loadCommands,
  onSend,
  onAbort,
}: {
  busy: boolean;
  disabled: boolean;
  loadCommands: () => Promise<SlashCommand[]>;
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
    <div className="composer">
      {matches.length > 0 && (
        <ul className="commands">
          {matches.map((command) => (
            <li key={command.name}>
              <button type="button" onClick={() => setText(`/${command.name} `)}>
                <code>/{command.name}</code> <span className="muted">{command.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          busy ? "The agent is working. Your message goes in as chosen below." : "Message the agent"
        }
        rows={3}
        disabled={disabled}
      />
      <div className="composer-row">
        {busy && (
          <label className="check">
            <select
              value={whileBusy}
              onChange={(event) => setWhileBusy(event.target.value as "steer" | "followUp")}
            >
              <option value="steer">Steer: after this turn</option>
              <option value="followUp">Follow up: after the run</option>
            </select>
          </label>
        )}
        <button type="button" onClick={send} disabled={disabled || sending || text.trim() === ""}>
          {busy ? "Queue" : "Send"}
        </button>
        {busy && (
          <button type="button" onClick={onAbort}>
            Stop
          </button>
        )}
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
    <div className="dialog-card">
      <strong>{dialog.title ?? "The agent asks"}</strong>
      {dialog.message && <p>{dialog.message}</p>}
      {dialog.method === "confirm" && (
        <div className="composer-row">
          <button type="button" onClick={() => onAnswer({ confirmed: true })}>
            Yes
          </button>
          <button type="button" onClick={() => onAnswer({ confirmed: false })}>
            No
          </button>
        </div>
      )}
      {dialog.method === "select" && (
        <div className="composer-row">
          {(dialog.options ?? []).map((option) => (
            <button key={option} type="button" onClick={() => onAnswer({ value: option })}>
              {option}
            </button>
          ))}
          <button type="button" onClick={() => onAnswer({ cancelled: true })}>
            Cancel
          </button>
        </div>
      )}
      {(dialog.method === "input" || dialog.method === "editor") && (
        <>
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={dialog.placeholder}
            rows={dialog.method === "editor" ? 8 : 2}
          />
          <div className="composer-row">
            <button type="button" onClick={() => onAnswer({ value })}>
              Answer
            </button>
            <button type="button" onClick={() => onAnswer({ cancelled: true })}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
