import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@pi-spore/shared";
import Type, { type Static } from "typebox";

/** The Codex CLI's `auth.json`, keeping only what a usage request needs. Other keys are allowed and ignored. */
const CodexAuth = Type.Object({
  auth_mode: Type.Literal("chatgpt"),
  tokens: Type.Object({ access_token: Type.String(), account_id: Type.String() }),
});

/** The login that works on ChatGPT's usage endpoint (ADR 0153). A token or account id never goes in an error. */
export interface CodexLogin {
  token: string;
  accountId: string;
}

/** The Codex CLI's ChatGPT login under `codexHome`, or an error that tells the user how to get one. */
export function readCodexLogin(codexHome: string): CodexLogin {
  const path = join(codexHome, "auth.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No Codex login at ${path}; run "codex login"`);
  }
  let auth: Static<typeof CodexAuth>;
  try {
    auth = parse(CodexAuth, JSON.parse(text), path);
  } catch {
    // A validation detail can quote the file, which holds the tokens.
    throw new Error(`The Codex login at ${path} is not a ChatGPT login`);
  }
  return { token: auth.tokens.access_token, accountId: auth.tokens.account_id };
}

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** The JSON body of ChatGPT's usage endpoint, as the Codex CLI asks for it. Read only: nothing is refreshed. */
export async function fetchCodexUsage(login: CodexLogin, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${login.token}`,
      "ChatGPT-Account-ID": login.accountId,
      "User-Agent": "codex-cli",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const refresh = response.status === 401 ? '; run "codex" once to refresh its login' : "";
    throw new Error(`ChatGPT's usage endpoint answered HTTP ${response.status}${refresh}`);
  }
  return await response.json();
}
