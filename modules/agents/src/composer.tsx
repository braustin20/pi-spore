import { type AgentDialog, IMAGE_TYPES, type PromptImage } from "@pi-spore/shared";
import { Button, cn, Notice, Select, Textarea } from "@pi-spore/ui";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { readDraft, writeDraft } from "./drafts.js";

export interface SlashCommand {
  name: string;
  description?: string;
}

/** An image waiting in the composer: its data for the request, and a blob URL for the thumbnail. */
interface Attachment {
  id: number;
  name: string;
  url: string;
  image: PromptImage;
}

const isImageType = (type: string): type is PromptImage["mimeType"] =>
  (IMAGE_TYPES as readonly string[]).includes(type);

/** A file's bytes as base64, without the `data:` prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadDraft(chatId: string): string {
  try {
    return readDraft(localStorage, chatId);
  } catch (caught) {
    console.error(`Could not read the draft of chat ${chatId}`, caught);
    return "";
  }
}

/**
 * The message box. Enter sends, Shift+Enter adds a line. Images come in by paste, drag and drop, or the image button
 * (PNG, JPEG, WebP, GIF); the server checks their size. While the agent works, a message goes in as a steer
 * (after the current turn) or a follow-up (after the run). Typing `/` lists slash commands. `controls` (model and
 * thinking) sit in the row under the text.
 */
export function Composer({
  chatId,
  busy,
  disabled,
  loadCommands,
  controls,
  imageInput,
  onSend,
  onAbort,
}: {
  /** Keys the saved draft: the unsent text stays in the browser, per chat. Images are not kept. */
  chatId: string;
  busy: boolean;
  disabled: boolean;
  loadCommands: () => Promise<SlashCommand[]>;
  controls?: ReactNode;
  /** Whether the chat's model takes images; undefined when unknown. */
  imageInput: boolean | undefined;
  onSend: (
    message: string,
    whileBusy: "steer" | "followUp",
    images: PromptImage[],
  ) => Promise<void>;
  onAbort: () => void;
}) {
  const [text, setText] = useState(() => loadDraft(chatId));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [refused, setRefused] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const shown = useRef(attachments);
  shown.current = attachments;
  // Free the thumbnails' blob URLs when the composer goes.
  useEffect(
    () => () => {
      for (const attachment of shown.current) URL.revokeObjectURL(attachment.url);
    },
    [],
  );

  // Save on every change; an empty text (after a successful send) clears the draft. A failed send leaves it.
  useEffect(() => {
    try {
      writeDraft(localStorage, chatId, text);
    } catch (caught) {
      console.error(`Could not save the draft of chat ${chatId}`, caught);
    }
  }, [chatId, text]);

  const addFiles = (files: readonly File[]) => {
    const wrong = files.filter((file) => !isImageType(file.type));
    setRefused(
      wrong.length > 0
        ? `Only PNG, JPEG, WebP, and GIF images can be sent: ${wrong.map((file) => file.name || file.type).join(", ")}`
        : undefined,
    );
    for (const file of files) {
      const mimeType = file.type;
      if (!isImageType(mimeType)) continue;
      readBase64(file)
        .then((data) => {
          const attachment: Attachment = {
            id: nextId.current++,
            name: file.name || "pasted image",
            url: URL.createObjectURL(file),
            image: { mimeType, data },
          };
          setAttachments((current) => [...current, attachment]);
        })
        .catch((caught: unknown) =>
          setRefused(caught instanceof Error ? caught.message : String(caught)),
        );
    }
  };

  const remove = (id: number) =>
    setAttachments((current) =>
      current.filter((attachment) => {
        if (attachment.id === id) URL.revokeObjectURL(attachment.url);
        return attachment.id !== id;
      }),
    );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    // A copied web page may bring text with the image; then the text still goes in.
    if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
    addFiles(files);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  };
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

  const empty = text.trim() === "" && attachments.length === 0;
  const send = () => {
    if (empty || sending || disabled) return;
    setSending(true);
    const sent = attachments;
    onSend(
      text.trim(),
      whileBusy,
      sent.map((attachment) => attachment.image),
    )
      .then(() => {
        setText("");
        for (const attachment of sent) URL.revokeObjectURL(attachment.url);
        setAttachments((current) => current.filter((attachment) => !sent.includes(attachment)));
        setRefused(undefined);
      })
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
      {(refused || (imageInput === false && attachments.length > 0)) && (
        <div className="mb-1.5 flex flex-col gap-1.5">
          {refused && <Notice tone="fail">{refused}</Notice>}
          {imageInput === false && attachments.length > 0 && (
            <Notice tone="warn">
              This chat's model does not take images. Pi sends a placeholder in their place. Pick
              another model to send them.
            </Notice>
          )}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; the image button does the same by keyboard */}
      <div
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border border-line bg-panel focus-within:border-muted",
          dragging && "border-accent focus-within:border-accent",
        )}
      >
        {attachments.length > 0 && (
          <ul
            className="m-0 flex list-none flex-wrap gap-2 px-3.5 pt-3"
            aria-label="Images to send"
          >
            {attachments.map((attachment) => (
              <li key={attachment.id} className="relative">
                <img
                  src={attachment.url}
                  alt={attachment.name}
                  title={attachment.name}
                  className="block size-16 rounded-lg border border-line object-cover"
                />
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={`Remove image ${attachment.name}`}
                  onClick={() => remove(attachment.id)}
                  className="absolute -top-2 -right-2 size-5 rounded-full [&_svg]:size-3"
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
          <input
            ref={picker}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add images"
            title="Add images (or paste, or drop them here)"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus />
          </Button>
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
          <Button variant="primary" onClick={send} disabled={disabled || sending || empty}>
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
      {dialog.message && (
        <p className="m-0 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{dialog.message}</p>
      )}
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
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option}</span>
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
