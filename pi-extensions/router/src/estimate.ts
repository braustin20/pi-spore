import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** About four characters per token. Deliberately rough: the budget leaves half the context free. */
export const tokensOfText = (text: string): number => Math.ceil(text.length / 4);

/** Path-like words: they contain a slash or end in a file extension. */
const PATH_WORD = /[\w@~.-]*[/\w.-]*\.[A-Za-z0-9]{1,10}\b|[\w@~.-]+(?:\/[\w@.-]+)+/g;

/** Files at most this many are counted, so a prompt full of paths cannot stall the router. */
const MAX_FILES = 200;

/** The text of a message's content, whatever its shape. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const {
        text,
        thinking,
        arguments: args,
      } = block as {
        text?: unknown;
        thinking?: unknown;
        arguments?: unknown;
      };
      if (typeof text === "string") return text;
      if (typeof thinking === "string") return thinking;
      return args === undefined ? "" : JSON.stringify(args);
    })
    .join("\n");
}

export interface Estimate {
  system: number;
  /** Conversation so far, including the brief. */
  conversation: number;
  /** Existing files the brief names, by size. */
  files: number;
  total: number;
  namedFiles: string[];
}

/** Tokens the task brings in at the start: system prompt, conversation (with the brief), and the files the brief names. */
export async function estimateTokens(
  systemPrompt: string,
  messages: readonly { role: string; content?: unknown }[],
  brief: string,
  cwd: string,
): Promise<Estimate> {
  const system = tokensOfText(systemPrompt);
  const conversation = messages.reduce(
    (sum, message) => sum + tokensOfText(contentText(message.content)),
    0,
  );
  const candidates = [...new Set(brief.match(PATH_WORD) ?? [])].slice(0, MAX_FILES);
  const namedFiles: string[] = [];
  let files = 0;
  for (const word of candidates) {
    const path = isAbsolute(word) ? word : resolve(cwd, word.replace(/^\.\//, ""));
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    namedFiles.push(word);
    files += Math.ceil(info.size / 4);
  }
  return { system, conversation, files, total: system + conversation + files, namedFiles };
}
