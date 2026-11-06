import { readFile } from "node:fs/promises";
import type { ChatMessage } from "@pi-spore/shared";

export interface Transcript {
  /** The working folder stored in the session header. */
  cwd: string | undefined;
  /** Messages on the active branch, oldest first, including those before a compaction. System messages are left out. */
  messages: ChatMessage[];
  /** The model selected last on the active branch: Pi resumes with it. */
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

interface Entry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: unknown;
  summary?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

/**
 * Reads a Pi session file (Pi docs: session-format.md) without starting Pi. The active branch is the path from the
 * last entry back to the root. Compactions show as a `compaction` message with the summary, so the full history
 * stays visible. Unparseable lines are skipped: a crash can leave a partial last line.
 */
export async function readTranscript(path: string): Promise<Transcript> {
  const text = await readFile(path, "utf8");
  let cwd: string | undefined;
  const entries = new Map<string, Entry>();
  let last: Entry | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      const header = entry as { cwd?: unknown };
      if (typeof header.cwd === "string") cwd = header.cwd;
      continue;
    }
    if (typeof entry.id !== "string") continue;
    entries.set(entry.id, entry);
    last = entry;
  }

  const branch: Entry[] = [];
  const seen = new Set<string>();
  for (let entry = last; entry && typeof entry.id === "string" && !seen.has(entry.id); ) {
    seen.add(entry.id);
    branch.push(entry);
    entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined;
  }
  branch.reverse();

  const messages: ChatMessage[] = [];
  let model: Transcript["model"];
  let thinkingLevel: string | undefined;
  for (const entry of branch) {
    if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      model = { provider: entry.provider, id: entry.modelId };
    } else if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      thinkingLevel = entry.thinkingLevel;
    } else if (
      entry.type === "message" &&
      typeof entry.message === "object" &&
      entry.message !== null
    ) {
      const message = entry.message as ChatMessage;
      if (typeof message.role === "string" && message.role !== "system") messages.push(message);
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      messages.push({
        role: "compaction",
        content: entry.summary,
        ...(Number.isNaN(at) ? {} : { timestamp: at }),
      });
    }
  }
  return {
    cwd,
    messages,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
