import type { Settings, SettingsOverride } from "@pi-spore/module-api";
import type { ProjectConfigView, ProjectTrait, SettingEntry } from "@pi-spore/shared";
import type { ProjectSettings } from "./settings.js";

/**
 * Resolves the worktree settings of a project (R17.2): defaults, then values detected from traits, then the
 * files. Each value carries its source.
 */
export async function resolveConfig(
  settings: Settings,
  keys: ProjectSettings,
  projectPath: string,
  traits: readonly ProjectTrait[],
  traitCopy: (traitId: string) => readonly string[] | undefined,
  override?: SettingsOverride,
): Promise<ProjectConfigView & { entries: SettingEntry[] }> {
  const copy = [...new Set(traits.flatMap((trait) => traitCopy(trait.id) ?? []))];
  const resolved = await settings.resolve({
    projectPath,
    ...(copy.length > 0 ? { detected: { [keys.worktreeCopy.key]: copy } } : {}),
    ...(override ? { override } : {}),
  });
  return {
    worktreeCopy: resolved.get(keys.worktreeCopy),
    branchPrefix: resolved.get(keys.branchPrefix),
    entries: resolved.entries(),
  };
}
