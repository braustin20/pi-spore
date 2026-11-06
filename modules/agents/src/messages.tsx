import type { ChatMessage, RunningTool } from "@pi-spore/shared";
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
    <details className={`tool tool-${state}`}>
      <summary>
        <code>{name}</code> <span className="muted">{state}</span>
      </summary>
      <pre>{typeof args === "string" ? args : json(args)}</pre>
      {output && <pre className="tool-output">{clip(output)}</pre>}
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
    <div className={`msg msg-assistant${streaming ? " streaming" : ""}`}>
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
            <details key={key} className="thinking">
              <summary className="muted">Thinking</summary>
              <MarkdownText text={block.thinking} />
            </details>
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
        <p className="error">{String(message.errorMessage ?? "The model returned an error")}</p>
      )}
      {message.stopReason === "aborted" && <p className="muted">Stopped.</p>}
    </div>
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
    <div className="messages">
      {messages.map((message, index) => {
        const key = `${message.role}-${message.timestamp ?? index}-${index}`;
        switch (message.role) {
          case "user":
            return (
              <div key={key} className="msg msg-user">
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
              <pre key={key} className="tool-output">
                {clip(plainText(message.content))}
              </pre>
            );
          case "compaction":
            return (
              <details key={key} className="compaction">
                <summary className="muted">Context compacted</summary>
                <MarkdownText text={plainText(message.content)} />
              </details>
            );
          case "bashExecution":
            return (
              <pre key={key} className="tool-output">
                $ {String(message.command ?? "")}
                {"\n"}
                {clip(String(message.output ?? ""))}
              </pre>
            );
          default:
            return null;
        }
      })}
      {streaming && (
        <AssistantMessage message={streaming} results={results} running={runningById} streaming />
      )}
    </div>
  );
}
