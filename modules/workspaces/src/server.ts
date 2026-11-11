import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { ApiError, type ServerModule, type SettingsOverride } from "@pi-spore/module-api";
import {
  ArchiveWorkspaceRequest,
  type ArchiveWorkspaceResponse,
  CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type Isolation,
  PlannerWorkspaceRequest,
  parseJsonBody,
  RenameWorkspaceRequest,
  type SettingsView,
  type StepReport,
  slugify,
  type Workspace,
  type WorkspaceState,
} from "@pi-spore/shared";
import {
  type CopyCreatedListener,
  type DeleteListener,
  type LeaveListener,
  type RemoveCopyListener,
  type ResumeListener,
  type RetentionListener,
  type StateChangeListener,
  type Workspaces,
  WorkspacesKey,
} from "./contract.js";
import { copyIgnoredFiles } from "./copy.js";

export * from "./contract.js";

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
  "ALTER TABLE workspaces_workspaces ADD COLUMN base TEXT",
  "ALTER TABLE workspaces_workspaces ADD COLUMN archived_at INTEGER",
  "UPDATE workspaces_workspaces SET archived_at = updated_at WHERE state = 'archived'",
  "ALTER TABLE workspaces_workspaces ADD COLUMN settings TEXT",
  "ALTER TABLE workspaces_workspaces ADD COLUMN settings_source TEXT",
  "ALTER TABLE workspaces_workspaces ADD COLUMN planner INTEGER NOT NULL DEFAULT 0",
  // ADR 0174: one planner workspace per project at most.
  "CREATE UNIQUE INDEX workspaces_one_planner ON workspaces_workspaces (project_id) WHERE planner = 1",
];

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  isolation: Isolation;
  path: string;
  line: string | null;
  base: string | null;
  state: WorkspaceState;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  /** JSON of the settings override, checked by the resolver at creation. */
  settings: string | null;
  settings_source: "workspace" | "run" | null;
  planner: number;
}

const overrideOf = (row: Row): SettingsOverride | undefined =>
  row.settings === null || row.settings_source === null
    ? undefined
    : { source: row.settings_source, values: JSON.parse(row.settings) };

const toWorkspace = (row: Row): Workspace => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  slug: row.slug,
  isolation: row.isolation,
  path: row.path,
  ...(row.line === null ? {} : { line: row.line }),
  ...(row.base === null ? {} : { base: row.base }),
  state: row.state,
  planner: row.planner === 1,
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
        "SELECT COUNT(*) AS n FROM workspaces_workspaces WHERE project_id = ? AND state != 'archived' AND planner = 0",
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

    /** A planner workspace lives as long as its project; the user does not rename, park, or archive it (ADR 0174). */
    const loadChangeable = (id: string): Row => {
      const row = load(id);
      if (row.planner === 1) {
        throw new ApiError(409, "planner_workspace", "The planner workspace cannot be changed");
      }
      return row;
    };

    const publish = (workspace: Workspace) =>
      host.events.publish("workspaces:list", { type: "workspace", workspace });

    const listRows = (filter: { projectId?: string; state?: string }): Row[] => {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.projectId) {
        where.push("project_id = ?");
        params.push(filter.projectId);
      }
      if (filter.state) {
        where.push("state = ?");
        params.push(filter.state);
      }
      return host.store.all<Row>(
        `SELECT * FROM workspaces_workspaces ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC`,
        ...params,
      );
    };

    const create = async (
      request: CreateWorkspaceRequest,
      options: { overrideSource?: "run"; planner?: boolean } = {},
    ): Promise<CreateWorkspaceResponse> => {
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
      const source = options.overrideSource ?? "workspace";
      const config = await projects.config(
        project,
        request.settings ? { source, values: request.settings } : undefined,
      );
      const warnings = await config.copyWarnings();

      let path = project.path;
      let line: string | undefined;
      let base: string | undefined;
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
        base = location.base ?? request.base;
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
        base: base ?? null,
        state: "active",
        created_at: now,
        updated_at: now,
        archived_at: null,
        settings: request.settings ? JSON.stringify(request.settings) : null,
        settings_source: request.settings ? source : null,
        planner: options.planner ? 1 : 0,
      };
      host.store.run(
        `INSERT INTO workspaces_workspaces
          (id, project_id, name, slug, isolation, path, line, base, state, created_at, updated_at,
           settings, settings_source, planner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.project_id,
        row.name,
        row.slug,
        row.isolation,
        row.path,
        row.line,
        row.base,
        row.state,
        row.created_at,
        row.updated_at,
        row.settings,
        row.settings_source,
        row.planner,
      );
      const workspace = toWorkspace(row);
      publish(workspace);
      const steps: StepReport[] = [];
      if (request.isolation !== "in-place") {
        for (const listener of createdListeners) {
          // The workspace exists now; a step that breaks is reported, not allowed to hide it.
          const report = await listener(workspace).catch(
            (error: unknown): StepReport => ({
              name: "after create",
              ok: false,
              message: (error as Error).message,
            }),
          );
          if (report) steps.push(report);
        }
      }
      return { workspace, copied, warnings, steps };
    };

    /** Calls for one project share one creation, so two at once do not both insert. */
    const plannerCreations = new Map<string, Promise<Workspace>>();
    const planner = async (projectId: string): Promise<Workspace> => {
      // A removed project's planner row stays behind; it must not be handed out again.
      await projects.get(projectId);
      const row = host.store.get<Row>(
        "SELECT * FROM workspaces_workspaces WHERE project_id = ? AND planner = 1",
        projectId,
      );
      if (row) return toWorkspace(row);
      const running = plannerCreations.get(projectId);
      if (running) return running;
      const pending = create({ projectId, name: "Plan", isolation: "in-place" }, { planner: true })
        .then((response) => response.workspace)
        .finally(() => plannerCreations.delete(projectId));
      plannerCreations.set(projectId, pending);
      return pending;
    };

    const leaveListeners: LeaveListener[] = [];
    const createdListeners: CopyCreatedListener[] = [];
    const removeListeners: RemoveCopyListener[] = [];
    const resumeListeners: ResumeListener[] = [];
    const stateListeners: StateChangeListener[] = [];
    const retentionListeners: RetentionListener[] = [];
    const deleteListeners: DeleteListener[] = [];
    const workspaces: Workspaces = {
      get: (id) => toWorkspace(load(id)),
      list: (filter = {}) => listRows(filter).map(toWorkspace),
      create,
      planner,
      beforeLeaveActive: (listener) => {
        leaveListeners.push(listener);
      },
      afterCopyCreated: (listener) => {
        createdListeners.push(listener);
      },
      beforeRemoveCopy: (listener) => {
        removeListeners.push(listener);
      },
      afterResume: (listener) => {
        resumeListeners.push(listener);
      },
      afterStateChange: (listener) => {
        stateListeners.push(listener);
      },
      onRetention: (listener) => {
        retentionListeners.push(listener);
      },
      beforeDeleteWorkspace: (listener) => {
        deleteListeners.push(listener);
      },
    };
    host.provide(WorkspacesKey, workspaces);

    const leaveActive = async (row: Row, next: "parked" | "archived") => {
      for (const listener of leaveListeners) await listener(toWorkspace(row), next);
    };

    const setState = (row: Row, state: WorkspaceState): Workspace => {
      const now = host.now();
      const archivedAt = state === "archived" ? now : null;
      host.store.run(
        "UPDATE workspaces_workspaces SET state = ?, updated_at = ?, archived_at = ? WHERE id = ?",
        state,
        now,
        archivedAt,
        row.id,
      );
      const workspace = toWorkspace({ ...row, state, updated_at: now, archived_at: archivedAt });
      publish(workspace);
      for (const listener of stateListeners) {
        try {
          listener(workspace, row.state);
        } catch (error) {
          host.log.error("A workspace state listener failed", {
            workspace: row.id,
            state,
            error: String(error),
          });
        }
      }
      return workspace;
    };

    const logFailure = (message: string, fields: Record<string, unknown>, error: unknown) =>
      host.log.error(message, { ...fields, error: String(error) });

    let sweeping = false;
    const sweep = async (): Promise<void> => {
      if (sweeping) return;
      sweeping = true;
      try {
        const days = await projects.retentionDays();
        if (days === 0) return;
        const cutoff = host.now() - days * DAY_MS;
        for (const listener of retentionListeners) {
          await listener(cutoff).catch((error: unknown) =>
            logFailure("A retention listener failed", {}, error),
          );
        }
        const responses = host.pruneResponses(cutoff);
        if (responses > 0)
          host.log.info("Retention deleted stored responses", { count: responses });
        const jobs = host.jobs.prune(cutoff);
        if (jobs > 0) host.log.info("Retention deleted ended jobs", { count: jobs });
        const old = host.store.all<Row>(
          "SELECT * FROM workspaces_workspaces WHERE state = 'archived' AND archived_at < ?",
          cutoff,
        );
        let deleted = 0;
        for (const row of old) {
          let failed = false;
          for (const listener of deleteListeners) {
            await listener(toWorkspace(row)).catch((error: unknown) => {
              failed = true;
              logFailure("A workspace delete listener failed", { workspace: row.id }, error);
            });
          }
          if (failed) continue;
          host.store.run("DELETE FROM workspaces_workspaces WHERE id = ?", row.id);
          host.events.publish("workspaces:list", { type: "removed", id: row.id });
          deleted++;
        }
        if (deleted > 0) host.log.info("Retention deleted archived workspaces", { count: deleted });
      } catch (error) {
        host.log.error("Retention sweep failed", { error: String(error) });
      } finally {
        sweeping = false;
      }
    };
    host.onStarted(sweep);
    setInterval(() => void sweep(), DAY_MS).unref();

    host.events.onSubscribe("workspaces:list", () => [
      { type: "snapshot", workspaces: listRows({}).map(toWorkspace) },
    ]);

    host.routes.get("/", (c) => {
      const projectId = c.req.query("projectId");
      const state = c.req.query("state");
      const rows = listRows({
        ...(projectId ? { projectId } : {}),
        ...(state ? { state } : {}),
      });
      return c.json({ workspaces: rows.map(toWorkspace) });
    });

    host.routes.post("/", async (c) => {
      const request = parseJsonBody(
        CreateWorkspaceRequest,
        await c.req.text(),
        "create workspace request",
      );
      return c.json(await create(request), 201);
    });

    host.routes.post("/planner", async (c) => {
      const request = parseJsonBody(
        PlannerWorkspaceRequest,
        await c.req.text(),
        "planner workspace request",
      );
      return c.json({ workspace: await planner(request.projectId) });
    });

    host.routes.get("/:id", (c) => c.json({ workspace: toWorkspace(load(c.req.param("id"))) }));

    host.routes.get("/:id/settings", async (c) => {
      const row = load(c.req.param("id"));
      const config = await projects.config(await projects.get(row.project_id), overrideOf(row));
      const body: SettingsView = { settings: config.entries };
      return c.json(body);
    });

    host.routes.patch("/:id", async (c) => {
      const request = parseJsonBody(RenameWorkspaceRequest, await c.req.text(), "rename request");
      const row = loadChangeable(c.req.param("id"));
      const now = host.now();
      host.store.run(
        "UPDATE workspaces_workspaces SET name = ?, updated_at = ? WHERE id = ?",
        request.name,
        now,
        row.id,
      );
      const workspace = toWorkspace({ ...row, name: request.name, updated_at: now });
      publish(workspace);
      return c.json({ workspace });
    });

    host.routes.post("/:id/park", async (c) => {
      const row = loadChangeable(c.req.param("id"));
      if (row.state !== "active")
        throw new ApiError(409, "bad_state", `Workspace is ${row.state}, not active`);
      await leaveActive(row, "parked");
      return c.json({ workspace: setState(row, "parked") });
    });

    host.routes.post("/:id/resume", (c) => {
      const row = loadChangeable(c.req.param("id"));
      if (row.state !== "parked")
        throw new ApiError(409, "bad_state", `Workspace is ${row.state}, not parked`);
      const workspace = setState(row, "active");
      for (const listener of resumeListeners) listener(workspace);
      return c.json({ workspace });
    });

    host.routes.post("/:id/archive", async (c) => {
      const request = parseJsonBody(ArchiveWorkspaceRequest, await c.req.text(), "archive request");
      const row = loadChangeable(c.req.param("id"));
      if (row.state === "archived")
        throw new ApiError(409, "bad_state", "Workspace is already archived");
      if (row.state === "active") await leaveActive(row, "archived");
      const steps: StepReport[] = [];
      const force = request.force === true;
      if (row.isolation !== "in-place") {
        for (const listener of removeListeners) {
          const report = await listener(toWorkspace(row), { force });
          if (!report) continue;
          if (!report.ok && !force) {
            throw new ApiError(
              409,
              `${report.name}_failed`,
              `${report.message}. Archive with force to remove the copy anyway.`,
            );
          }
          steps.push(report);
        }
        const project = await projects.get(row.project_id);
        await projects
          .vcsFor(project)
          .removeCopy(
            project,
            { path: row.path, ...(row.line === null ? {} : { line: row.line }) },
            { force },
          );
      }
      const body: ArchiveWorkspaceResponse = { workspace: setState(row, "archived"), steps };
      return c.json(body);
    });
  },
};
