import { join } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import { removeInside } from "@pi-spore/module-api/node";
import {
  type ActionRun,
  type ActionTrigger,
  type ActionView,
  parseJsonBody,
  StartActionRequest,
  type StepReport,
  type Workspace,
} from "@pi-spore/shared";
import { readActions } from "./config.js";
import { type Actions, ActionsKey } from "./contract.js";
import { ActionRunner, hasEnded, MIGRATIONS } from "./runner.js";

export * from "./contract.js";

/** Longest a request may wait for a run to change, so clients and proxies do not time out. */
const MAX_WAIT_MS = 30_000;

/** Reads an optional non-negative integer query parameter. */
function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) {
    throw new ApiError(400, "bad_query", `"${name}" must be a non-negative integer`);
  }
  return Number(value);
}

export interface ActionsModuleOptions {
  /** The environment runs start from. Default: the server's. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export function createActionsModule(options: ActionsModuleOptions = {}): ServerModule {
  return {
    id: "actions",
    requires: ["projects", "workspaces"],
    core: false,
    setup(host) {
      host.store.migrate("actions", MIGRATIONS);
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const runner = new ActionRunner({
        store: host.store,
        log: host.log,
        logsDir: join(host.home.logs, "actions"),
        now: host.now,
        newId: host.newId,
        baseEnv: options.baseEnv ?? process.env,
      });

      const actionsOf = async (workspace: Workspace): Promise<ActionView[]> =>
        readActions(projects, await projects.get(workspace.projectId));

      const start = async (
        workspace: Workspace,
        name: string,
        trigger: ActionTrigger,
        key?: string,
      ): Promise<{ run: ActionRun; done: Promise<ActionRun> }> => {
        const action = (await actionsOf(workspace)).find((candidate) => candidate.name === name);
        if (!action) {
          throw new ApiError(
            404,
            "action_not_found",
            `No action "${name}" in this project's .pi-spore/config.toml`,
          );
        }
        const project = await projects.get(workspace.projectId);
        // No await between this check and the insert in runner.start, so two starts with one key cannot both pass.
        if (key !== undefined) {
          const existing = runner.byKey(workspace.id, key);
          if (existing) return { run: existing, done: runner.wait(existing.id) };
        }
        return runner.start(
          workspace,
          action,
          trigger,
          {
            PI_SPORE_WORKSPACE_ID: workspace.id,
            PI_SPORE_WORKSPACE_PATH: workspace.path,
            PI_SPORE_PROJECT_ROOT: project.path,
          },
          key,
        );
      };

      const actions: Actions = {
        list: (workspaceId) => actionsOf(workspaces.get(workspaceId)),
        start: async (workspaceId, name, trigger, options) =>
          (await start(workspaces.get(workspaceId), name, trigger, options?.key)).run,
        wait: (runId) => runner.wait(runId),
        get: (runId) => runner.get(runId),
        readLog: (runId, from, waitMs) => runner.readLog(runId, from, waitMs),
        cancel: (runId) => runner.cancel(runId),
      };
      host.provide(ActionsKey, actions);

      /** Runs a lifecycle action if the project has it, and reports how it went. */
      const lifecycle = async (
        workspace: Workspace,
        name: "setup" | "teardown",
        trigger: ActionTrigger,
      ): Promise<StepReport | undefined> => {
        try {
          if (!(await actionsOf(workspace)).some((action) => action.name === name))
            return undefined;
          const { done } = await start(workspace, name, trigger);
          const run = await done;
          const ok = run.status === "succeeded";
          const how =
            run.exitCode !== undefined
              ? `with exit code ${run.exitCode}`
              : (run.error ?? run.signal ?? run.status);
          return {
            name,
            ok,
            message: ok ? `${name} succeeded` : `${name} failed ${how}; log: ${run.logPath}`,
            runId: run.id,
            logPath: run.logPath,
          };
        } catch (error) {
          return { name, ok: false, message: `${name} did not run: ${(error as Error).message}` };
        }
      };

      // R2.7: setup after a new copy, teardown before a copy is removed.
      workspaces.afterCopyCreated((workspace) => lifecycle(workspace, "setup", "create"));
      workspaces.beforeRemoveCopy((workspace) => lifecycle(workspace, "teardown", "archive"));

      // Runs in a copy that is about to be removed must stop first.
      workspaces.beforeLeaveActive(async (workspace, next) => {
        if (next !== "archived") return;
        const open = runner.unfinished(workspace.id);
        for (const run of open) runner.cancel(run.id);
        await Promise.all(open.map((run) => runner.wait(run.id)));
      });

      // ADR 0121: the runs and logs of a deleted workspace go with it.
      const logsRoot = join(host.home.logs, "actions");
      workspaces.beforeDeleteWorkspace(async (workspace) => {
        host.store.run("DELETE FROM actions_runs WHERE workspace_id = ?", workspace.id);
        await removeInside(host.home.logs, join(logsRoot, workspace.id));
      });

      workspaces.onRetention(async (cutoff) => {
        const old = host.store.all<{ id: string; log_path: string }>(
          "SELECT id, log_path FROM actions_runs WHERE ended_at IS NOT NULL AND ended_at < ?",
          cutoff,
        );
        let count = 0;
        for (const run of old) {
          try {
            await removeInside(logsRoot, run.log_path);
            host.store.run("DELETE FROM actions_runs WHERE id = ?", run.id);
            count++;
          } catch (error) {
            host.log.error("Retention could not delete an action run", {
              run: run.id,
              error: String(error),
            });
          }
        }
        if (count > 0) host.log.info("Retention deleted action runs", { count });
      });

      host.routes.get("/workspaces/:id", async (c) =>
        c.json({ actions: await actionsOf(workspaces.get(c.req.param("id"))) }),
      );

      host.routes.get("/workspaces/:id/runs", (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        return c.json({ runs: runner.list(workspace.id) });
      });

      host.routes.post("/workspaces/:id/runs", async (c) => {
        const request = parseJsonBody(
          StartActionRequest,
          await c.req.text(),
          "start action request",
        );
        const workspace = workspaces.get(c.req.param("id"));
        if (workspace.state !== "active") {
          throw new ApiError(
            409,
            "workspace_not_active",
            `The workspace is ${workspace.state}; resume it first`,
          );
        }
        const { run } = await start(workspace, request.action, "user");
        return c.json({ run }, 201);
      });

      /** `?wait=<ms>` answers when the run ends or the time is up. */
      host.routes.get("/runs/:id", async (c) => {
        const id = c.req.param("id");
        const wait = Math.min(intParam(c.req.query("wait"), "wait") ?? 0, MAX_WAIT_MS);
        let run = runner.get(id);
        if (wait > 0 && !hasEnded(run)) {
          let timer: NodeJS.Timeout | undefined;
          run = await Promise.race([
            runner.wait(id),
            new Promise<ActionRun>((resolve) => {
              timer = setTimeout(() => resolve(runner.get(id)), wait);
            }),
          ]);
          clearTimeout(timer);
        }
        return c.json({ run });
      });

      /** `?from=<byte>` reads on from there; `?wait=<ms>` waits for new output first. */
      host.routes.get("/runs/:id/log", async (c) => {
        const from = intParam(c.req.query("from"), "from");
        const wait = Math.min(intParam(c.req.query("wait"), "wait") ?? 0, MAX_WAIT_MS);
        return c.json(await runner.readLog(c.req.param("id"), from, wait));
      });

      host.routes.post("/runs/:id/cancel", (c) =>
        c.json({ run: runner.cancel(c.req.param("id")) }),
      );
    },
  };
}

export const actionsModule = createActionsModule();
