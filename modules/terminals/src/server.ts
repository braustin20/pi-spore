import { existsSync } from "node:fs";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  CreateTerminalRequest,
  parseJsonBody,
  TERMINAL_ACK_CHARS,
  type Workspace,
} from "@pi-spore/shared";
import { spawn } from "node-pty";
import { type ShellCommand, TerminalManager } from "./manager.js";

export type { ShellCommand } from "./manager.js";

export interface TerminalsModuleOptions {
  /** The program each terminal runs. Default: the user's `$SHELL`, from `baseEnv`. */
  shell?: ShellCommand;
  /** The environment terminals start from. Default: the server's. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Most terminals open at once, across all workspaces (setting `terminals.maxOpen`). */
  maxOpen?: number;
  /** Recent output a reconnect gets, in characters (setting `terminals.scrollbackChars`). */
  scrollbackChars?: number;
  /** Unacked output, in characters, at which the PTY pauses and below which it resumes. */
  flowControl?: { highChars: number; lowChars: number };
  /** Starts PTYs. Default: node-pty's `spawn`. Tests wrap it to watch pause and resume. */
  spawn?: typeof spawn;
}

/** The server's env without the host terminal's Orca and herdr identity, as agents get it (spike Q1). */
function terminalEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^(ORCA|HERDR)_/.test(key)) env[key] = value;
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra };
}

/** Defaults: 8 terminals, about 1 MB of scrollback each, pause above 100,000 unacked characters. Settings will override them once the settings module lands. */
export function createTerminalsModule(options: TerminalsModuleOptions = {}): ServerModule {
  return {
    id: "terminals",
    requires: ["projects", "workspaces"],
    core: false,
    setup(host) {
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const baseEnv = options.baseEnv ?? process.env;
      const maxOpen = options.maxOpen ?? 8;
      const flow = options.flowControl ?? { highChars: 100_000, lowChars: 10_000 };
      // The browser acks in steps of TERMINAL_ACK_CHARS, so a lower resume mark could keep the PTY paused for good.
      if (flow.lowChars <= TERMINAL_ACK_CHARS || flow.highChars <= flow.lowChars) {
        throw new Error(
          `terminals flow control needs ${TERMINAL_ACK_CHARS} < lowChars < highChars; got ${flow.lowChars} and ${flow.highChars}`,
        );
      }
      const terminals = new TerminalManager({
        shell: () => {
          if (options.shell) return options.shell;
          // No fallback shell: a terminal that is not the user's own would surprise them.
          if (!baseEnv.SHELL) {
            throw new ApiError(
              500,
              "shell_not_set",
              "SHELL is not set in the server's environment; terminals run $SHELL",
            );
          }
          return { command: baseEnv.SHELL, args: [] };
        },
        maxOpen,
        scrollbackChars: options.scrollbackChars ?? 1024 * 1024,
        flow,
        spawn: options.spawn ?? spawn,
        now: host.now,
        newId: host.newId,
      });

      const activeWorkspace = (id: string): Workspace => {
        const workspace = workspaces.get(id);
        if (workspace.state !== "active") {
          throw new ApiError(
            409,
            "workspace_not_active",
            `The workspace is ${workspace.state}; resume it first`,
          );
        }
        return workspace;
      };

      // Parking stops work in a workspace and archiving removes its folder, so its shells end first.
      workspaces.beforeLeaveActive((workspace) => terminals.closeWorkspace(workspace.id));

      host.routes.get("/workspaces/:id", (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        return c.json({ terminals: terminals.list(workspace.id), max: maxOpen });
      });

      host.routes.post("/workspaces/:id", async (c) => {
        const request = parseJsonBody(
          CreateTerminalRequest,
          await c.req.text(),
          "create terminal request",
        );
        const workspace = activeWorkspace(c.req.param("id"));
        if (!existsSync(workspace.path)) {
          throw new ApiError(
            409,
            "folder_missing",
            `The workspace folder is gone: ${workspace.path}`,
          );
        }
        const project = await projects.get(workspace.projectId);
        const env = terminalEnv(baseEnv, {
          PI_SPORE_WORKSPACE_ID: workspace.id,
          PI_SPORE_WORKSPACE_PATH: workspace.path,
          PI_SPORE_PROJECT_ROOT: project.path,
        });
        const terminal = terminals.open(workspace, request, env);
        host.log.info("Terminal opened", { terminal: terminal.id, workspace: workspace.id });
        return c.json({ terminal }, 201);
      });

      host.routes.delete("/:id", async (c) => {
        const terminal = await terminals.close(c.req.param("id"));
        host.log.info("Terminal closed", { terminal: terminal.id });
        return c.json({ terminal });
      });

      host.sockets.add("/:id/socket", (params) => terminals.connect(params.id as string));
    },
  };
}

export const terminalsModule = createTerminalsModule();
