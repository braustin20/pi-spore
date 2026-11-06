import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import type { ProjectConfigView, ProjectTrait, SettingSource } from "@pi-spore/shared";
import { parse, ValidationError } from "@pi-spore/shared";
import { parse as parseToml } from "smol-toml";
import Type from "typebox";

/** The parts of `<project>/.pi-spore/config.toml` this module reads. Other modules own other sections. */
const ConfigFile = Type.Object(
  {
    worktree: Type.Optional(
      Type.Object(
        {
          copy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          branch_prefix: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9._-]+$" })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: true },
);

// R17.3: the project file may be committed and never chooses models.
const MODEL_KEYS = new Set(["model", "models", "provider", "thinking"]);

function findModelKey(value: unknown, path: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (MODEL_KEYS.has(key)) return here;
    const found = findModelKey(child, here);
    if (found) return found;
  }
  return undefined;
}

type ConfigFile = ReturnType<typeof parseConfigText>;

export function parseConfigText(text: string, file: string) {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ApiError(
      422,
      "bad_project_config",
      `${file} is not valid TOML: ${(error as Error).message}`,
    );
  }
  const modelKey = findModelKey(raw, "");
  if (modelKey) {
    throw new ApiError(
      422,
      "bad_project_config",
      `${file} sets "${modelKey}". Project files never choose models; use Pi settings or a local override.`,
    );
  }
  try {
    return parse(ConfigFile, raw, file);
  } catch (error) {
    if (error instanceof ValidationError)
      throw new ApiError(422, "bad_project_config", error.message);
    throw error;
  }
}

async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseConfigText(text, path);
}

export const DEFAULT_BRANCH_PREFIX = "spore";

/**
 * Resolves the worktree settings of a project (R17.2): defaults, then values detected from traits, then the
 * project file, then the local override. Each value carries its source.
 */
export async function resolveConfig(
  projectPath: string,
  traits: readonly ProjectTrait[],
  traitCopy: (traitId: string) => readonly string[] | undefined,
): Promise<ProjectConfigView> {
  const dir = join(projectPath, ".pi-spore");
  const projectFile = await readConfigFile(join(dir, "config.toml"));
  const localFile = await readConfigFile(join(dir, "config.local.toml"));

  let worktreeCopy: { value: string[]; source: SettingSource } = { value: [], source: "default" };
  const detected = [...new Set(traits.flatMap((trait) => traitCopy(trait.id) ?? []))];
  if (detected.length > 0) worktreeCopy = { value: detected, source: "detected" };
  if (projectFile?.worktree?.copy)
    worktreeCopy = { value: projectFile.worktree.copy, source: "project file" };
  if (localFile?.worktree?.copy)
    worktreeCopy = { value: localFile.worktree.copy, source: "local override" };

  let branchPrefix: { value: string; source: SettingSource } = {
    value: DEFAULT_BRANCH_PREFIX,
    source: "default",
  };
  if (projectFile?.worktree?.branch_prefix) {
    branchPrefix = { value: projectFile.worktree.branch_prefix, source: "project file" };
  }
  if (localFile?.worktree?.branch_prefix) {
    branchPrefix = { value: localFile.worktree.branch_prefix, source: "local override" };
  }

  return { worktreeCopy, branchPrefix };
}
