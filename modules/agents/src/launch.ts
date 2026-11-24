import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Built-in Pi extensions (Pi docs: settings.md). `--no-extensions` turns them off, so enabled ones are listed again. */
const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];

/**
 * pi-spore's own Pi extensions, loaded into every agent. The path works from `src/` and from `dist/`, which sit at the
 * same depth.
 */
export const SPORE_EXTENSIONS: readonly string[] = [
  fileURLToPath(new URL("../../../pi-extensions/router", import.meta.url)),
  fileURLToPath(new URL("../../../pi-extensions/spore-bridge", import.meta.url)),
];

/**
 * pi-spore's own Pi skills, loaded into every agent (ADR 0193). Each entry is a folder with a `SKILL.md`. Like
 * `SPORE_EXTENSIONS`, the path works from `src/` and from `dist/`, which sit at the same depth.
 */
export const SPORE_SKILLS: readonly string[] = [
  fileURLToPath(new URL("../../../pi-skills/project-wiki", import.meta.url)),
];

/**
 * The tools of a side chat (ADR 0033). `--tools` is an allowlist: Pi never registers a built-in or extension tool
 * that it does not name, so no extension can turn `edit`, `write`, `bash`, `codemode`, or a subagent tool back on, and
 * a forked session's recorded loadout cannot either. Pi keeps MCP tools (`mcp__*`) registered past an allowlist that
 * names none, and MCP servers can write, so `--exclude-tools` removes them. `request_human_input` (spore-bridge) only
 * files a question; spore-bridge's `check` and `run_action` run project commands and are left out. `artifacts_list`
 * and `artifacts_read` change nothing, so a side chat may use them; `artifacts_write` is left out.
 */
export const SIDE_CHAT_TOOLS: readonly string[] = [
  "--tools",
  "read,grep,find,ls,request_human_input,artifacts_list,artifacts_read",
  "--exclude-tools",
  "mcp__*",
];

/**
 * The tools of a planner chat (ADR 0174): the side chat's tools, plus the kanban tools to write the plan as cards,
 * the web tools to research it, and `start_helper` (ADR 0176) for read-only scouts and researchers. Built like
 * `SIDE_CHAT_TOOLS`, so nothing that edits files or runs commands loads. Not `subagent`: that could start a worker.
 */
export const PLANNER_CHAT_TOOLS: readonly string[] = [
  "--tools",
  "read,grep,find,ls,request_human_input,artifacts_list,artifacts_read,kanban_list_cards,kanban_read_card,kanban_add_card,kanban_update_card,web_search,fetch_content,get_search_content,start_helper",
  "--exclude-tools",
  "mcp__*",
];

/**
 * The tools of a read-only pipeline stage agent (R6): the side chat's read tools, plus spore-bridge's `report`, the
 * one tool that ends its turn, and the two ask tools, which spore-bridge registers only where they belong:
 * `ask_coordinator` inside a run lane and `ask_orchestrator` outside one (ADR 0179). `request_human_input` is left
 * out, so a stage question goes through the path the pipeline waits for.
 */
export const STAGE_REVIEWER_TOOLS: readonly string[] = [
  "--tools",
  "read,grep,find,ls,artifacts_list,artifacts_read,report,ask_coordinator,ask_orchestrator",
  "--exclude-tools",
  "mcp__*",
];

/**
 * The tools of a pipeline stage worker (R6, ADR 0179): Pi's normal tools, less `contact_supervisor`. That tool comes
 * from pi-subagents and works only in a child pi-subagents started; a stage agent is a top-level Pi process, so the
 * call only fails, and the agent then guesses. It asks with `ask_orchestrator` instead.
 */
export const STAGE_WORKER_TOOLS: readonly string[] = ["--exclude-tools", "contact_supervisor"];

/**
 * The tools of a workspace chat (ADR 0120, ADR 0189): Pi's normal tools, less pi-subagents' loader
 * `subagents_enable`, so `subagent` is active from the first request. On a bridge model that fixes the tool list for
 * a whole prompt, the loader turns `subagent` on only at the next user prompt, and a Home answer is not one
 * (pi-subagents docs, configuration.md, "Tool activation lifecycle"). Excluding a tool that is not registered, as
 * when pi-subagents is not installed, does nothing.
 */
export const WORKSPACE_CHAT_TOOLS: readonly string[] = ["--exclude-tools", "subagents_enable"];

/**
 * The `extras` that `loaded` does not cover: an extra is dropped when `loaded` names its path, or names a folder
 * above it, so a package the user's setup already loads is not loaded a second time.
 */
function notLoaded(loaded: readonly string[], extras: readonly string[]): string[] {
  return extras.filter(
    (path) => !loaded.some((resource) => resource === path || resource.startsWith(`${path}/`)),
  );
}

/**
 * The launch arguments that load the user's Pi setup minus excluded packages (ADR 0025): `--no-extensions`,
 * `--no-skills`, and `--no-prompt-templates`, then one explicit flag per remaining resource. Pi's own package
 * manager resolves the list from the user's and the project's settings without loading any extension code. Packages
 * that are configured but not installed are skipped, never installed. `extraExtensions` (pi-spore's own) come after
 * the user's extensions, and `extraSkills` (pi-spore's own) after the user's skills, each unless the user's setup
 * already loads the same path.
 */
export async function resolveResourceArgs(
  cwd: string,
  agentDir: string,
  excludeSources: readonly string[],
  extraExtensions: readonly string[] = [],
  extraSkills: readonly string[] = [],
): Promise<string[]> {
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    builtinExtensions: BUILTIN_EXTENSIONS,
  });
  const resolved = await manager.resolve(async () => "skip");
  const excluded = new Set(excludeSources);
  const keep = (resource: { enabled: boolean; metadata: { source: string } }) =>
    resource.enabled && !excluded.has(resource.metadata.source);
  const extensions = resolved.extensions.filter(keep).map((resource) => resource.path);
  const skills = resolved.skills.filter(keep).map((resource) => resource.path);
  return [
    "--no-extensions",
    ...[...extensions, ...notLoaded(extensions, extraExtensions)].flatMap((path) => ["-e", path]),
    "--no-skills",
    ...[...skills, ...notLoaded(skills, extraSkills)].flatMap((path) => ["--skill", path]),
    "--no-prompt-templates",
    ...resolved.prompts.filter(keep).flatMap((resource) => ["--prompt-template", resource.path]),
  ];
}

export interface RoleDefaults {
  provider?: string;
  modelId?: string;
  thinking?: string;
}

/** Pi's `settings.json` is not plain JSON. Pi cannot read it either (it parses with `JSON.parse`). */
export class PiSettingsNotJsonError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not valid JSON`);
  }
}

/** The path of Pi's settings file in an agent folder. */
export const piSettingsPath = (agentDir: string): string => join(agentDir, "settings.json");

/**
 * Pi's `<agentDir>/settings.json` as parsed JSON, or undefined when the file does not exist. Throws
 * `PiSettingsNotJsonError` when it does not parse. Like Pi, it ignores a leading BOM.
 */
export async function readPiSettings(agentDir: string): Promise<unknown | undefined> {
  const path = piSettingsPath(agentDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new PiSettingsNotJsonError(path);
  }
}

/**
 * The model and thinking level of a role from the user's pi-subagents settings (ADR 0013):
 * `subagents.agentOverrides.<role>.model` as `provider/id`, and `.thinking`. Missing settings mean Pi's own defaults.
 */
export async function readRoleDefaults(agentDir: string, role: string): Promise<RoleDefaults> {
  const settings = await readPiSettings(agentDir);
  if (settings === undefined) return {};
  const override = (settings as { subagents?: { agentOverrides?: Record<string, unknown> } } | null)
    ?.subagents?.agentOverrides?.[role];
  if (typeof override !== "object" || override === null) return {};
  const { model, thinking } = override as { model?: unknown; thinking?: unknown };
  const defaults: RoleDefaults = {};
  if (typeof model === "string" && model.trim()) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      defaults.provider = model.slice(0, slash);
      defaults.modelId = model.slice(slash + 1);
    } else defaults.modelId = model;
  }
  if (typeof thinking === "string" && thinking.trim()) defaults.thinking = thinking;
  return defaults;
}

/**
 * The role's defaults with a chat's own model (`provider/id`, from the card or picker that made the chat, ADR 0120)
 * and thinking level (a level the user picked before its first message, ADR 0175) in place of the role's. Null means
 * the role's. Both were validated when they were set.
 */
export function withModel(
  defaults: RoleDefaults,
  model: string | null,
  thinking: string | null,
): RoleDefaults {
  let own = defaults;
  if (model !== null) {
    const slash = model.indexOf("/");
    own = { ...own, provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  return thinking === null ? own : { ...own, thinking };
}

/** Launch arguments that pick the role's model for a new session. A resumed session keeps the model it had. */
export function modelArgs(defaults: RoleDefaults): string[] {
  return [
    ...(defaults.provider ? ["--provider", defaults.provider] : []),
    ...(defaults.modelId ? ["--model", defaults.modelId] : []),
    ...(defaults.thinking ? ["--thinking", defaults.thinking] : []),
  ];
}

/** The environment for an agent: the server's, without the host terminal's Orca and herdr identity (spike Q1). */
export function agentEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^(ORCA|HERDR)_/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The folder of the installed pi-subagents package, found the way `resolveResourceArgs` finds the user's packages
 * (ADR 0181). Undefined when the package is not installed.
 */
export async function findSubagentsRoot(agentDir: string): Promise<string | undefined> {
  const manager = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir),
    builtinExtensions: BUILTIN_EXTENSIONS,
  });
  const resolved = await manager.resolve(async () => "skip");
  const found = [...resolved.extensions, ...resolved.skills, ...resolved.prompts].find(
    ({ metadata }) => /^npm:pi-subagents(@|$)/.test(metadata.source) && metadata.packageRoot,
  );
  return found?.metadata.packageRoot;
}
