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
 * The tools of a side chat (ADR 0033). `--tools` is an allowlist: Pi never registers a built-in or extension tool
 * that it does not name, so no extension can turn `edit`, `write`, `bash`, `codemode`, or a subagent tool back on, and
 * a forked session's recorded loadout cannot either. Pi keeps MCP tools (`mcp__*`) registered past an allowlist that
 * names none, and MCP servers can write, so `--exclude-tools` removes them. `request_human_input` (spore-bridge) only
 * files a question; spore-bridge's `check` and `run_action` run project commands and are left out.
 */
export const SIDE_CHAT_TOOLS: readonly string[] = [
  "--tools",
  "read,grep,find,ls,request_human_input",
  "--exclude-tools",
  "mcp__*",
];

/**
 * The launch arguments that load the user's Pi setup minus excluded packages (ADR 0025): `--no-extensions`,
 * `--no-skills`, and `--no-prompt-templates`, then one explicit flag per remaining resource. Pi's own package
 * manager resolves the list from the user's and the project's settings without loading any extension code. Packages
 * that are configured but not installed are skipped, never installed. `extraExtensions` (pi-spore's own) come after the
 * user's, unless the user's setup already loads the same path.
 */
export async function resolveResourceArgs(
  cwd: string,
  agentDir: string,
  excludeSources: readonly string[],
  extraExtensions: readonly string[] = [],
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
  const extra = extraExtensions.filter(
    (path) => !extensions.some((loaded) => loaded === path || loaded.startsWith(`${path}/`)),
  );
  return [
    "--no-extensions",
    ...[...extensions, ...extra].flatMap((path) => ["-e", path]),
    "--no-skills",
    ...resolved.skills.filter(keep).flatMap((resource) => ["--skill", resource.path]),
    "--no-prompt-templates",
    ...resolved.prompts.filter(keep).flatMap((resource) => ["--prompt-template", resource.path]),
  ];
}

export interface RoleDefaults {
  provider?: string;
  modelId?: string;
  thinking?: string;
}

/**
 * The model and thinking level of a role from the user's pi-subagents settings (ADR 0013):
 * `subagents.agentOverrides.<role>.model` as `provider/id`, and `.thinking`. Missing settings mean Pi's own defaults.
 */
export async function readRoleDefaults(agentDir: string, role: string): Promise<RoleDefaults> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${join(agentDir, "settings.json")} is not valid JSON`);
  }
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
 * The role's defaults with a chat's own model (`provider/id`) in place of the role's. Thinking stays the role's
 * (ADR 0120). The model was checked when the chat was created.
 */
export function withModel(defaults: RoleDefaults, model: string | null): RoleDefaults {
  if (model === null) return defaults;
  const slash = model.indexOf("/");
  return { ...defaults, provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
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
