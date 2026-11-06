import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Built-in Pi extensions (Pi docs: settings.md). `--no-extensions` turns them off, so enabled ones are listed again. */
const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];

/**
 * The launch arguments that load the user's Pi setup minus excluded packages (ADR 0025): `--no-extensions`,
 * `--no-skills`, and `--no-prompt-templates`, then one explicit flag per remaining resource. Pi's own package
 * manager resolves the list from the user's and the project's settings without loading any extension code. Packages
 * that are configured but not installed are skipped, never installed.
 */
export async function resolveResourceArgs(
  cwd: string,
  agentDir: string,
  excludeSources: readonly string[],
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
  return [
    "--no-extensions",
    ...resolved.extensions.filter(keep).flatMap((resource) => ["-e", resource.path]),
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
