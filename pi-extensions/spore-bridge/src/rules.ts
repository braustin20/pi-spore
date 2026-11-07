import { dirname, resolve } from "node:path";

/** The prompt section name. Pi wraps it in `<pi_spore_rules>` tags. */
export const RULES_SECTION = "pi_spore_rules";

/**
 * The rules pi-spore agents get in place of the user's global AGENTS.md (ADR 0031). Tool-specific advice lives in
 * each tool's `promptGuidelines`.
 */
export const RULES = `You are a pi-spore agent: the worker of one workspace in pi-spore, a local agent workbench.
pi-spore created this workspace's folder and manages its branch, worktree, and project actions. The user's global
AGENTS.md is left out on purpose; these rules take its place. Project AGENTS.md files still apply.

- The user is often away from the chat. Ask them with request_human_input and stop; the answer comes back as a new
  message, possibly after a restart.
- Do the work in this workspace's folder. Do not create other worktrees or start agents in other terminals.
- Before you say the work is done, run check and fix what it reports.
- Never merge into the base branch and never turn on auto-merge. A human merges.`;

/**
 * The rules of a read-only side chat (ADR 0033). The read-only tools are what enforce it; these rules tell the model
 * why edits are not possible, so it does not try to work around them.
 */
export const SIDE_RULES = `You are a pi-spore side chat: a read-only chat next to the worker of one workspace in pi-spore, a local
agent workbench. The user's global AGENTS.md is left out on purpose; these rules take its place. Project AGENTS.md
files still apply.

- You can read and search files. You cannot change files, run commands, or start agents; those tools are not there.
- Answer questions, explain code, and review. When a change is needed, describe it so the user can give it to the
  worker chat.
- Your history may start with a copy of the worker's conversation. Tools used there may be missing here.`;

export interface PromptOptions {
  contextFiles: { path: string; content: string }[];
  sections: Record<string, string>;
}

/**
 * Drops the context files that sit directly in Pi's agent folder (the global AGENTS.md and its variants) and adds
 * the pi-spore rules. Pi rebuilds these options for every run, so this runs on every `before_agent_start`.
 */
export function applyRules(
  options: PromptOptions,
  agentDir: string,
  chatKind: "worker" | "side" = "worker",
): void {
  const global = resolve(agentDir);
  options.contextFiles = options.contextFiles.filter(
    (file) => dirname(resolve(file.path)) !== global,
  );
  options.sections[RULES_SECTION] = chatKind === "side" ? SIDE_RULES : RULES;
}
