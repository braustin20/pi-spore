import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  AddProjectRequest,
  type Project,
  type ProjectConfigView,
  type ProjectLines,
  type ProjectTrait,
  parseJsonBody,
  slugify,
} from "@pi-spore/shared";
import { checkConfigSection, readConfigFiles, resolveConfig } from "./config.js";
import {
  type Projects,
  ProjectsKey,
  type RemovalGuard,
  type ResolvedProjectConfig,
  type TraitDefinition,
  type VcsProvider,
} from "./contract.js";
import { readGlobalSettings } from "./settings.js";

export * from "./contract.js";

const MIGRATIONS = [
  `CREATE TABLE projects_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    vcs TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

interface Row {
  id: string;
  name: string;
  slug: string;
  path: string;
  vcs: string;
  created_at: number;
}

export const projectsModule: ServerModule = {
  id: "projects",
  requires: [],
  core: true,
  setup(host) {
    host.store.migrate("projects", MIGRATIONS);
    const providers: VcsProvider[] = [];
    const traits: TraitDefinition[] = [];
    const guards: RemovalGuard[] = [];

    const detectTraits = async (path: string): Promise<ProjectTrait[]> => {
      const found = await Promise.all(traits.map((trait) => trait.detect(path)));
      return found.filter((trait): trait is ProjectTrait => trait !== undefined);
    };

    const toProject = async (row: Row): Promise<Project> => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      path: row.path,
      vcs: row.vcs,
      traits: await detectTraits(row.path),
      createdAt: row.created_at,
    });

    const providerOf = (kind: string): VcsProvider => {
      const provider = providers.find((candidate) => candidate.kind === kind);
      if (!provider) {
        throw new ApiError(
          503,
          "vcs_unavailable",
          `No VCS provider "${kind}" is enabled for this project`,
        );
      }
      return provider;
    };

    const projects: Projects = {
      registerVcs(provider) {
        if (providers.some((existing) => existing.kind === provider.kind)) {
          throw new Error(`VCS provider "${provider.kind}" is registered twice`);
        }
        providers.push(provider);
        providers.sort((a, b) => b.priority - a.priority);
      },
      registerTrait(trait) {
        if (traits.some((existing) => existing.id === trait.id)) {
          throw new Error(`Project trait "${trait.id}" is registered twice`);
        }
        traits.push(trait);
      },
      addRemovalGuard(guard) {
        guards.push(guard);
      },
      async get(id) {
        const row = host.store.get<Row>("SELECT * FROM projects_projects WHERE id = ?", id);
        if (!row) throw new ApiError(404, "project_not_found", `No project ${id}`);
        return toProject(row);
      },
      async list() {
        const rows = host.store.all<Row>(
          "SELECT * FROM projects_projects ORDER BY name COLLATE NOCASE",
        );
        return Promise.all(rows.map(toProject));
      },
      vcsFor(project) {
        return providerOf(project.vcs);
      },
      async config(project): Promise<ResolvedProjectConfig> {
        const view = await resolveConfig(
          project.path,
          project.traits,
          (id) => traits.find((trait) => trait.id === id)?.worktreeCopy,
        );
        return {
          ...view,
          copyWarnings: async () => {
            const active = traits.filter((trait) =>
              project.traits.some((found) => found.id === trait.id),
            );
            const lists = await Promise.all(
              active.map((trait) => trait.copyWarnings?.(project.path) ?? []),
            );
            return lists.flat();
          },
        };
      },
      configFiles: (project) => readConfigFiles(project.path),
      checkConfigSection,
      globalSettings: () => readGlobalSettings(host.home.root),
    };
    host.provide(ProjectsKey, projects);

    const uniqueSlug = (name: string): string => {
      const base = slugify(name);
      let slug = base;
      for (let n = 2; host.store.get("SELECT 1 FROM projects_projects WHERE slug = ?", slug); n++) {
        slug = `${base}-${n}`;
      }
      return slug;
    };

    host.routes.get("/", async (c) => c.json({ projects: await projects.list() }));

    host.routes.post("/", async (c) => {
      const request = parseJsonBody(AddProjectRequest, await c.req.text(), "add project request");
      if (!isAbsolute(request.path)) {
        throw new ApiError(
          400,
          "relative_path",
          `Project path must be absolute, got "${request.path}"`,
        );
      }
      const info = await stat(request.path).catch(() => undefined);
      if (!info?.isDirectory())
        throw new ApiError(400, "not_a_folder", `${request.path} is not a folder`);

      const path = await realpath(request.path);
      let provider: VcsProvider | undefined;
      for (const candidate of providers) {
        if (await candidate.detect(path)) {
          provider = candidate;
          break;
        }
      }
      if (!provider)
        throw new ApiError(503, "vcs_unavailable", `No VCS provider can handle ${path}`);
      const root = await provider.root(path);

      const existing = host.store.get<Row>("SELECT * FROM projects_projects WHERE path = ?", root);
      if (existing) {
        throw new ApiError(
          409,
          "project_exists",
          `${root} is already registered as "${existing.name}"`,
        );
      }
      const name = request.name ?? basename(root);
      const row: Row = {
        id: host.newId(),
        name,
        slug: uniqueSlug(name),
        path: root,
        vcs: provider.kind,
        created_at: host.now(),
      };
      host.store.run(
        "INSERT INTO projects_projects (id, name, slug, path, vcs, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        row.id,
        row.name,
        row.slug,
        row.path,
        row.vcs,
        row.created_at,
      );
      return c.json({ project: await toProject(row) }, 201);
    });

    host.routes.get("/settings", async (c) =>
      c.json({ settings: await projects.globalSettings() }),
    );

    host.routes.get("/:id", async (c) =>
      c.json({ project: await projects.get(c.req.param("id")) }),
    );

    host.routes.get("/:id/config", async (c) => {
      const config = await projects.config(await projects.get(c.req.param("id")));
      const view: ProjectConfigView = {
        worktreeCopy: config.worktreeCopy,
        branchPrefix: config.branchPrefix,
      };
      return c.json({ config: view, warnings: await config.copyWarnings() });
    });

    host.routes.get("/:id/lines", async (c) => {
      const project = await projects.get(c.req.param("id"));
      const provider = projects.vcsFor(project);
      if (!provider.lines) {
        throw new ApiError(
          422,
          "not_supported",
          `${project.vcs} projects have no lines (branches)`,
        );
      }
      const lines: ProjectLines = await provider.lines.list(project);
      return c.json(lines);
    });

    host.routes.delete("/:id", async (c) => {
      const project = await projects.get(c.req.param("id"));
      for (const guard of guards) guard(project);
      host.store.run("DELETE FROM projects_projects WHERE id = ?", project.id);
      return c.json({ removed: project.id });
    });
  },
};
