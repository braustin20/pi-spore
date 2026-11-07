import type { ChatMessage, RunningTool } from "@pi-spore/shared";
import { Chip, cn, Spinner } from "@pi-spore/ui";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Block = Record<string, unknown> & { type?: unknown };

const blocksOf = (message: ChatMessage): Block[] =>
  Array.isArray(message.content) ? (message.content as Block[]) : [];

/** The text of a user or tool message: a string, or the text blocks of a block list. */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: Block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Long tool output stays in the transcript; the page shows its start and end. */
function clip(text: string, max = 4_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max / 2)}\n... ${text.length - max} characters hidden ...\n${text.slice(-max / 2)}`;
}

const TOOL_TONE = { running: "run", error: "fail", done: "ok", waiting: "neutral" } as const;

/** A one-line hint of a tool call's arguments for the collapsed row, such as the path or command. */
function summary(args: unknown): string {
  if (typeof args === "string") return args.split("\n")[0] ?? "";
  if (typeof args !== "object" || args === null) return "";
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? (first.split("\n")[0] ?? "") : "";
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="m-0 max-h-96 overflow-auto rounded-md bg-bg p-2.5 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-muted">
      {children}
    </pre>
  );
}

/** A folded block such as Thinking or a compaction summary. */
function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-open:rotate-90"
        />
        {label}
      </summary>
      <div className="mt-1.5 border-l-2 border-line pl-3 text-muted">{children}</div>
    </details>
  );
}

function MarkdownText({ text }: { text: string }) {
  // react-markdown builds React elements and skips raw HTML, so agent output cannot inject markup.
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function ToolCall({
  block,
  result,
  running,
}: {
  block: Block;
  result?: ChatMessage;
  running?: RunningTool;
}) {
  const name = String(block.name ?? "tool");
  const args =
    block.arguments && Object.keys(block.arguments as object).length > 0
      ? block.arguments
      : block.argsText;
  const state = running ? "running" : result ? (result.isError ? "error" : "done") : "waiting";
  const output = result
    ? plainText(result.content)
    : running?.partial !== undefined
      ? plainText(running.partial)
      : "";
  return (
    <details className="group rounded-lg border border-line bg-panel text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90"
        />
        <code className={cn("font-medium", state === "error" ? "text-fail" : "text-fg")}>
          {name}
        </code>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
          {summary(args)}
        </span>
        {state === "running" && <Spinner />}
        <Chip tone={TOOL_TONE[state]}>{state}</Chip>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line p-2">
        <Pre>{typeof args === "string" ? args : json(args)}</Pre>
        {output && <Pre>{clip(output)}</Pre>}
      </div>
    </details>
  );
}

function AssistantMessage({
  message,
  results,
  running,
  streaming,
}: {
  message: ChatMessage;
  results: Map<string, ChatMessage>;
  running: Map<string, RunningTool>;
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 text-[15px] leading-relaxed",
        streaming && "border-l-2 border-accent pl-3",
      )}
    >
      {blocksOf(message).map((block, index) => {
        const key = `${index}-${String(block.type)}`;
        if (block.type === "text" && typeof block.text === "string")
          return <MarkdownText key={key} text={block.text} />;
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          return (
            <Fold key={key} label="Thinking">
              <MarkdownText text={block.thinking} />
            </Fold>
          );
        }
        if (block.type === "toolCall") {
          const id = String(block.id ?? "");
          const result = results.get(id);
          const live = running.get(id);
          return (
            <ToolCall
              key={key}
              block={block}
              {...(result ? { result } : {})}
              {...(live ? { running: live } : {})}
            />
          );
        }
        return null;
      })}
      {message.stopReason === "error" && (
        <p className="m-0 text-sm text-fail">
          {String(message.errorMessage ?? "The model returned an error")}
        </p>
      )}
      {message.stopReason === "aborted" && <p className="m-0 text-sm text-muted">Stopped.</p>}
    </div>
  );
}

/** A reply that has produced nothing to read yet shows only as the working indicator, not as an empty box. */
function hasVisibleContent(message: ChatMessage): boolean {
  return blocksOf(message).some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") ||
      (block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim() !== ""),
  );
}

export function MessageList({
  messages,
  streaming,
  running,
}: {
  messages: readonly ChatMessage[];
  streaming?: ChatMessage;
  running: readonly RunningTool[];
}) {
  // Tool results arrive as their own messages; show each inside the call it answers.
  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string")
      results.set(message.toolCallId, message);
  }
  const runningById = new Map(running.map((tool) => [tool.toolCallId, tool]));
  const shownCalls = new Set<string>();
  for (const message of [...messages, ...(streaming ? [streaming] : [])]) {
    for (const block of blocksOf(message))
      if (block.type === "toolCall") shownCalls.add(String(block.id));
  }

  return (
    <div className="flex flex-col gap-5">
      {messages.map((message, index) => {
        const key = `${message.role}-${message.timestamp ?? index}-${index}`;
        switch (message.role) {
          case "user":
            return (
              <div
                key={key}
                className="max-w-[85%] self-end rounded-xl border border-line bg-raised px-3.5 py-2 text-[15px]"
              >
                <MarkdownText text={plainText(message.content)} />
              </div>
            );
          case "assistant":
            return (
              <AssistantMessage
                key={key}
                message={message}
                results={results}
                running={runningById}
              />
            );
          case "toolResult":
            // Shown inside its tool call; only an orphan result is shown on its own.
            return shownCalls.has(String(message.toolCallId)) ? null : (
              <Pre key={key}>{clip(plainText(message.content))}</Pre>
            );
          case "compaction":
            return (
              <Fold key={key} label="Context compacted">
                <MarkdownText text={plainText(message.content)} />
              </Fold>
            );
          case "bashExecution":
            return (
              <Pre key={key}>
                $ {String(message.command ?? "")}
                {"\n"}
                {clip(String(message.output ?? ""))}
              </Pre>
            );
          default:
            return null;
        }
      })}
      {streaming && hasVisibleContent(streaming) && (
        <AssistantMessage message={streaming} results={results} running={runningById} streaming />
      )}
    </div>
  );
}
