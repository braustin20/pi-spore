import type { Projects } from "@pi-spore/mod-projects/server";
import { ApiError } from "@pi-spore/module-api";
import type { ActionView, Project } from "@pi-spore/shared";
import Type from "typebox";

/** `[actions.<name>]` in `<project>/.pi-spore/config.toml` (architecture 13). */
const ActionTable = Type.Object(
  {
    run: Type.Union([
      Type.String({ minLength: 1 }),
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    ]),
    shell: Type.Optional(Type.Boolean()),
    exclusive: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ActionsSection = Type.Object(
  { actions: Type.Optional(Type.Record(Type.String(), ActionTable)) },
  { additionalProperties: true },
);

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function readSection(
  projects: Projects,
  file: { path: string; data: Record<string, unknown> } | undefined,
  source: "project file" | "local override",
): ActionView[] {
  if (!file) return [];
  const section = projects.checkConfigSection(ActionsSection, file.data, file.path);
  return Object.entries(section.actions ?? {}).map(([name, table]) => {
    const where = `${file.path}: action "${name}"`;
    if (!NAME.test(name)) {
      throw new ApiError(
        422,
        "bad_project_config",
        `${where}: names use lowercase letters, digits, "-" and "_"`,
      );
    }
    const shell = table.shell === true;
    // A string is only run through a shell, and only when the file says so; argv arrays never are.
    if (typeof table.run === "string" && !shell) {
      throw new ApiError(
        422,
        "bad_project_config",
        `${where}: "run" is a string, which needs shell = true. Use an argv array to run without a shell.`,
      );
    }
    if (Array.isArray(table.run) && shell) {
      throw new ApiError(
        422,
        "bad_project_config",
        `${where}: shell = true needs "run" as one string`,
      );
    }
    return {
      name,
      run: table.run,
      shell,
      exclusive: table.exclusive === true,
      ...(table.description === undefined ? {} : { description: table.description }),
      source,
    };
  });
}

/** The project's actions, sorted by name. The local override replaces a whole action of the same name. */
export async function readActions(projects: Projects, project: Project): Promise<ActionView[]> {
  const files = await projects.configFiles(project);
  const byName = new Map<string, ActionView>();
  for (const action of readSection(projects, files.project, "project file"))
    byName.set(action.name, action);
  for (const action of readSection(projects, files.local, "local override"))
    byName.set(action.name, action);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
