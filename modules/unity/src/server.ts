import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProjectsKey, type TraitDefinition } from "@pi-spore/mod-projects/server";
import type { ServerModule } from "@pi-spore/module-api";

/** The editor version from `ProjectSettings/ProjectVersion.txt`, or undefined if this is not a Unity project. */
export async function readEditorVersion(projectPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(projectPath, "ProjectSettings", "ProjectVersion.txt"), "utf8");
  } catch {
    return undefined;
  }
  return /^m_EditorVersion:\s*(\S+)/m.exec(text)?.[1] ?? "unknown";
}

export const unityTrait: TraitDefinition = {
  id: "unity",
  async detect(projectPath) {
    const version = await readEditorVersion(projectPath);
    return version === undefined ? undefined : { id: "unity", detail: version };
  },
  // R10.2: the import cache and the IDE project files, all gitignored.
  worktreeCopy: ["Library", "*.csproj", "*.sln"],
  async copyWarnings(projectPath) {
    const locked = await stat(join(projectPath, "Temp", "UnityLockfile")).catch(() => undefined);
    return locked
      ? [
          "Unity may have the main project open. The copied Library can be inconsistent; close Unity for a clean copy.",
        ]
      : [];
  },
};

export const unityModule: ServerModule = {
  id: "unity",
  requires: ["projects"],
  core: false,
  setup(host) {
    host.use(ProjectsKey).registerTrait(unityTrait);
  },
};
