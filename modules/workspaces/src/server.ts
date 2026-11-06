import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  ArchiveWorkspaceRequest,
  CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type Isolation,
  parseJsonBody,
  RenameWorkspaceRequest,
  slugify,
  type Workspace,
  type WorkspaceState,
} from "@pi-spore/shared";
import { copyIgnoredFiles } from "./copy.js";

const MIGRATIONS = [
  `CREATE TABLE workspaces_workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    isolation TEXT NOT NULL,
    path TEXT NOT NULL,
    line TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX workspaces_by_project ON workspaces_workspaces (project_id, state)",
];

interface Row {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  isolation: Isolation;
  path: string;
  line: string | null;
  state: WorkspaceState;
  created_at: number;
  updated_at: number;
}

const toWorkspace = (row: Row): Workspace => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  slug: row.slug,
  isolation: row.isolation,
  path: row.path,
  ...(row.line === null ? {} : { line: row.line }),
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const workspacesModule: ServerModule = {
  id: "workspaces",
  requires: ["projects"],
  core: true,
  setup(host) {
    host.store.migrate("workspaces", MIGRATIONS);
    const projects = host.use(ProjectsKey);

    projects.addRemovalGuard((project) => {
      const open = host.store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workspaces_workspaces WHERE project_id = ? AND state != 'archived'",
        project.id,
      );
      if (open && open.n > 0) {
        throw new ApiError(
          409,
          "project_in_use",
          `${project.name} has ${open.n} open workspaces; archive them first`,
        );
      }
    });

    const load = (id: string): Row => {
      const row = host.store.get<Row>("SELECT * FROM workspaces_workspaces WHERE id = ?", id);
      if (!row) throw new ApiError(404, "workspace_not_found", `No workspace ${id}`);
      return row;
    };

    const setState = (row: Row, state: WorkspaceState): Workspace => {
      const now = host.now();
      host.store.run(
        "UPDATE workspaces_workspaces SET state = ?, updated_at = ? WHERE id = ?",
        state,
        now,
        row.id,
      );
      return toWorkspace({ ...row, state, updated_at: now });
    };

    host.routes.get("/", (c) => {
      const projectId = c.req.query("projectId");
      const state = c.req.query("state");
      const where: string[] = [];
      const params: string[] = [];
      if (projectId) {
        where.push("project_id = ?");
        params.push(projectId);
      }
      if (state) {
        where.push("state = ?");
        params.push(state);
      }
      const rows = host.store.all<Row>(
        `SELECT * FROM workspaces_workspaces ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC`,
        ...params,
      );
      return c.json({ workspaces: rows.map(toWorkspace) });
    });

    host.routes.post("/", async (c) => {
      const request = parseJsonBody(
        CreateWorkspaceRequest,
        await c.req.text(),
        "create workspace request",
      );
      const project = await projects.get(request.projectId);
      const provider = projects.vcsFor(project);
      if (!provider.isolationModes.includes(request.isolation)) {
        throw new ApiError(
          422,
          "not_supported",
          `${project.vcs} projects do not support "${request.isolation}"`,
        );
      }
      if (request.isolation === "existing" && !request.line) {
        throw new ApiError(
          400,
          "line_required",
          'Isolation "existing" needs the line (branch) to check out',
        );
      }

      const id = host.newId();
      const slug = slugify(request.name);
      const short = id.slice(-6).toLowerCase();
      const config = await projects.config(project);
      const warnings = await config.copyWarnings();

      let path = project.path;
      let line: string | undefined;
      let copied: string[] = [];
      if (request.isolation !== "in-place") {
        path = join(host.home.worktrees, project.slug, `${slug}-${short}`);
        line =
          request.isolation === "new"
            ? `${config.branchPrefix.value}/${slug}-${short}`
            : (request.line as string);
        // Providers create only the copy itself, not the per-project folder around it.
        await mkdir(dirname(path), { recursive: true });
        const location = await provider.createCopy(project, {
          isolation: request.isolation,
          path,
          line,
          ...(request.base ? { base: request.base } : {}),
        });
        line = location.line;
        try {
          copied = await copyIgnoredFiles(host.exec, project.path, path, config.worktreeCopy.value);
        } catch (error) {
          // Leave nothing half-made behind: the copy is new and holds no work yet.
          await provider
            .removeCopy(project, location, { force: true })
            .catch((cleanup: unknown) => {
              host.log.error("Could not remove a failed workspace copy", {
                path,
                error: String(cleanup),
              });
            });
          throw error;
        }
      }

      const now = host.now();
      const row: Row = {
        id,
        project_id: project.id,
        name: request.name,
        slug,
        isolation: request.isolation,
        path,
        line: line ?? null,
        state: "active",
        created_at: now,
        updated_at: now,
      };
      host.store.run(
        `INSERT INTO workspaces_workspaces
          (id, project_id, name, slug, isolation, path, line, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.project_id,
        row.name,
        row.slug,
        row.isolation,
        row.path,
        row.line,
        row.state,
        row.created_at,
        row.updated_at,
      );
      const body: CreateWorkspaceResponse = { workspace: toWorkspace(row), copied, warnings };
      return c.json(body, 201);
    });

    host.routes.get("/:id", (c) => c.json({ workspace: toWorkspace(load(c.req.param("id"))) }));

    host.routes.patch("/:id", async (c) => {
      const request = parseJsonBody(RenameWorkspaceRequest, await c.req.text(), "rename request");
      const row = load(c.req.param("id"));
      const now = host.now();
      host.store.run(
        "UPDATE workspaces_workspaces SET name = ?, updated_at = ? WHERE id = ?",
        request.name,
        now,
        row.id,
      );
      return c.json({ workspace: toWorkspace({ ...row, name: request.name, updated_at: now }) });
    });

    host.routes.post("/:id/park", (c) => {
      const row = load(c.req.param("id"));
      if (row.state !== "active")
        throw new ApiError(409, "bad_state", `Workspace is ${row.state}, not active`);
      return c.json({ workspace: setState(row, "parked") });
    });

    host.routes.post("/:id/resume", (c) => {
      const row = load(c.req.param("id"));
      if (row.state !== "parked")
        throw new ApiError(409, "bad_state", `Workspace is ${row.state}, not parked`);
      return c.json({ workspace: setState(row, "active") });
    });

    host.routes.post("/:id/archive", async (c) => {
      const request = parseJsonBody(ArchiveWorkspaceRequest, await c.req.text(), "archive request");
      const row = load(c.req.param("id"));
      if (row.state === "archived")
        throw new ApiError(409, "bad_state", "Workspace is already archived");
      if (row.isolation !== "in-place") {
        const project = await projects.get(row.project_id);
        await projects
          .vcsFor(project)
          .removeCopy(
            project,
            { path: row.path, ...(row.line === null ? {} : { line: row.line }) },
            { force: request.force === true },
          );
      }
      return c.json({ workspace: setState(row, "archived") });
    });
  },
};
