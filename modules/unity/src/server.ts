import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionsKey } from "@pi-spore/mod-actions/server";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { ApprovalsKey } from "@pi-spore/mod-attention/server";
import { ProjectsKey, type TraitDefinition } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  CloseEditorRequest,
  type OpenUnityResponse,
  parseJsonBody,
  type UnityWorkspaceView,
} from "@pi-spore/shared";
import { UnityEditorsKey } from "./contract.js";
import {
  createEditors,
  type ListProcesses,
  listProcesses,
  MIGRATIONS,
  type UnityCommand,
} from "./editors.js";
import { pause, registerGates, TEST_DEADLINE_MS } from "./gates.js";

export * from "./contract.js";

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

export interface UnityModuleOptions {
  /** The `unity` CLI. Default: `unity` on the PATH. */
  unity?: UnityCommand;
  /** Lists processes to find editors by `-projectpath`. Default: `/proc`. */
  processes?: ListProcesses;
  /** How a test gate waits between looks at the editor. Default: a timer that a cancel ends. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long `unity test` may run before pi-spore stops its process. Default: its own 30 minute timeout and a minute. */
  testDeadlineMs?: number;
  /** Where test reports are written before they move into the artifacts. Default: the temp folder. */
  reportDir?: string;
}

export function createUnityModule(options: UnityModuleOptions = {}): ServerModule {
  return {
    id: "unity",
    requires: ["projects", "workspaces", "actions", "agents", "artifacts", "attention"],
    core: false,
    setup(host) {
      host.store.migrate("unity", MIGRATIONS);
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      projects.registerTrait(unityTrait);
      const unity = options.unity ?? { command: "unity", args: [] };
      const editors = createEditors({
        store: host.store,
        exec: host.exec,
        unity,
        processes: options.processes ?? listProcesses,
        now: host.now,
        projects,
        workspaces,
      });
      host.provide(UnityEditorsKey, editors);
      const recentTests = registerGates({
        actions: host.use(ActionsKey),
        agents: host.use(AgentsKey),
        approvals: host.use(ApprovalsKey),
        artifacts: host.use(ArtifactsKey),
        editors,
        unity,
        sleep: options.sleep ?? pause,
        testDeadlineMs: options.testDeadlineMs ?? TEST_DEADLINE_MS,
        reportDir: options.reportDir ?? tmpdir(),
      });

      // Archiving removes the folder, which must not happen under an open editor. Force does not skip this.
      workspaces.beforeRemoveCopy(async (workspace) => {
        const project = await projects.get(workspace.projectId);
        if (!project.traits.some((trait) => trait.id === "unity")) return undefined;
        const { editors: open } = await editors.scan(project.id, { status: false });
        if (open.some((editor) => editor.path === resolve(workspace.path))) {
          throw new ApiError(
            409,
            "editor_open",
            `Unity has ${workspace.path} open. Save and close it in Unity before archiving.`,
          );
        }
        return undefined;
      });

      // ADR 0121: the lease of a deleted workspace goes with it.
      workspaces.beforeDeleteWorkspace(async (workspace) => {
        host.store.run("DELETE FROM unity_leases WHERE workspace_id = ?", workspace.id);
      });

      host.routes.get("/workspaces/:id", async (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        const project = await projects.get(workspace.projectId);
        const trait = project.traits.find((candidate) => candidate.id === "unity");
        const view: UnityWorkspaceView = trait
          ? {
              unity: true,
              editorVersion: trait.detail ?? "unknown",
              editors: await editors.editors(project.id),
              tests: await recentTests(workspace),
            }
          : { unity: false };
        return c.json(view);
      });

      host.routes.post("/workspaces/:id/open", async (c) => {
        const body: OpenUnityResponse = await editors.open(c.req.param("id"), "user");
        return c.json(body);
      });

      host.routes.post("/editors/close", async (c) => {
        const request = parseJsonBody(
          CloseEditorRequest,
          await c.req.text(),
          "close editor request",
        );
        await editors.close(request.projectId, request.path);
        return c.json({ closed: resolve(request.path) });
      });
    },
  };
}

export const unityModule = createUnityModule();
