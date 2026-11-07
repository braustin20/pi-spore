import {
  ActionList,
  ActionLog,
  ActionRun,
  ArchiveWorkspaceResponse,
  CreateWorkspaceResponse,
  DEFAULT_URL,
  HealthResponse,
  type Isolation,
  Project,
  ProjectList,
  parse,
  type StepReport,
  type Workspace,
  WorkspaceList,
  Workspace as WorkspaceSchema,
} from "@pi-spore/shared";
import Type, { type Static, type TSchema } from "typebox";

export interface CliDeps {
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** Writes text as is, for streamed logs. */
  write: (text: string) => void;
  err: (line: string) => void;
  /** The API token from `PI_SPORE_TOKEN` or the server's token file; undefined if neither exists. */
  readToken: () => string | undefined;
  /** Resolves a path argument against the shell's working folder. */
  resolvePath: (path: string) => string;
  newKey: () => string;
}

const USAGE = `Usage: pi-spore <command> [options] [--json]

Commands:
  health                                   Show whether the pi-spore server is running
  project list                             List registered projects
  project add <path> [--name <name>]       Register a Git checkout or a folder
  project rm <project>                     Unregister a project (files stay)
  ws list [--project <project>] [--state active|parked|archived]
  ws new <project> <name> [--mode new|existing|in-place] [--line <branch>] [--base <branch>]
                                           Start a workspace. new: worktree on a new branch (default)
  ws rename <id> <name>
  ws park <id> | ws resume <id>
  ws archive <id> [--force]                Remove the copy; --force also deletes uncommitted work
                                           and goes on after a failed teardown
  action list <workspace>                  List a workspace's actions
  action run <workspace> <name>            Run an action and follow its log; exits 1 if it fails
  action cancel <run id>

<project> is a project id or slug. <workspace> is a workspace id.

Environment:
  PI_SPORE_URL    Server address (default ${DEFAULT_URL})
  PI_SPORE_TOKEN  API token (default: read from the server's token file)`;

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const usageError = (message: string) => new CliError(`${message}\n\n${USAGE}`, 2);

/** Splits `--flag value` options from positional arguments. */
function parseArgs(
  args: readonly string[],
  flags: readonly string[],
  switches: readonly string[] = [],
) {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const on = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (switches.includes(name)) on.add(name);
    else if (flags.includes(name)) {
      const value = args[++i];
      if (value === undefined) throw usageError(`--${name} needs a value`);
      options[name] = value;
    } else throw usageError(`Unknown option ${arg}`);
  }
  return { positional, options, on };
}

class Api {
  constructor(
    private readonly deps: CliDeps,
    private readonly base: string,
  ) {}

  async call<S extends TSchema>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<Static<S>> {
    const token = this.deps.readToken();
    if (!token) {
      throw new CliError("No API token: start the pi-spore server once, or set PI_SPORE_TOKEN", 1);
    }
    const headers: Record<string, string> = { "x-pi-spore-token": token };
    if (method !== "GET") headers["idempotency-key"] = this.deps.newKey();
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.deps.fetch(new URL(`/api/${path}`, this.base), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliError(`pi-spore server is not reachable at ${this.base}: ${String(error)}`, 1);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CliError(
        `pi-spore server at ${this.base} answered ${response.status} without JSON`,
        1,
      );
    }
    if (!response.ok) {
      const error = (payload as { error?: { message?: string } }).error;
      throw new CliError(error?.message ?? `pi-spore server answered ${response.status}`, 1);
    }
    try {
      return parse(schema, payload, `${method} ${path} response`);
    } catch (error) {
      throw new CliError(`pi-spore server sent a bad response: ${String(error)}`, 1);
    }
  }

  /** Finds a project by id or slug. */
  async project(ref: string): Promise<Project> {
    const { projects } = await this.call("GET", "projects", ProjectList);
    const found = projects.find((project) => project.id === ref || project.slug === ref);
    if (!found) throw new CliError(`No project "${ref}". See: pi-spore project list`, 1);
    return found;
  }
}

const ProjectBody = Type.Object({ project: Project });
const WorkspaceBody = Type.Object({ workspace: WorkspaceSchema });

function projectLine(project: Project): string {
  const traits = project.traits.map((trait) =>
    trait.detail ? `${trait.id} ${trait.detail}` : trait.id,
  );
  return `${project.slug.padEnd(20)} ${project.vcs.padEnd(6)} ${project.path}${traits.length ? `  [${traits.join(", ")}]` : ""}`;
}

function workspaceLine(workspace: Workspace): string {
  return `${workspace.id}  ${workspace.state.padEnd(8)} ${workspace.name}  ${workspace.line ?? workspace.isolation}  ${workspace.path}`;
}

async function health(deps: CliDeps, base: string, json: boolean): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(new URL("/api/health", base));
  } catch (error) {
    throw new CliError(`pi-spore server is not reachable at ${base}: ${String(error)}`, 1);
  }
  if (!response.ok) {
    throw new CliError(
      `pi-spore server at ${base} answered ${response.status} ${response.statusText}`,
      1,
    );
  }
  let body: HealthResponse;
  try {
    body = parse(HealthResponse, await response.json(), "health response");
  } catch (error) {
    throw new CliError(
      `pi-spore server at ${base} sent a bad health response: ${String(error)}`,
      1,
    );
  }
  if (json) return deps.out(JSON.stringify(body));
  const modules = body.modules.length > 0 ? body.modules.join(", ") : "none";
  deps.out(
    `ok  version ${body.version}  up ${Math.round(body.uptimeMs / 1000)}s  modules: ${modules}`,
  );
}

async function projectCommand(
  api: Api,
  deps: CliDeps,
  args: string[],
  json: boolean,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list" && rest.length === 0) {
    const { projects } = await api.call("GET", "projects", ProjectList);
    if (json) return deps.out(JSON.stringify(projects));
    if (projects.length === 0)
      return deps.out("No projects. Add one with: pi-spore project add <path>");
    for (const project of projects) deps.out(projectLine(project));
    return;
  }
  if (sub === "add") {
    const { positional, options } = parseArgs(rest, ["name"]);
    if (positional.length !== 1) throw usageError("project add takes one path");
    const request = {
      path: deps.resolvePath(positional[0] as string),
      ...(options.name ? { name: options.name } : {}),
    };
    const { project } = await api.call("POST", "projects", ProjectBody, request);
    return deps.out(json ? JSON.stringify(project) : `Added ${projectLine(project)}`);
  }
  if (sub === "rm" && rest.length === 1) {
    const project = await api.project(rest[0] as string);
    await api.call("DELETE", `projects/${project.id}`, Type.Object({ removed: Type.String() }));
    return deps.out(
      json ? JSON.stringify({ removed: project.id }) : `Removed ${project.slug} (files kept)`,
    );
  }
  throw usageError(`Unknown command: project ${args.join(" ")}`);
}

const MODES: readonly Isolation[] = ["new", "existing", "in-place"];

async function workspaceCommand(
  api: Api,
  deps: CliDeps,
  args: string[],
  json: boolean,
): Promise<void> {
  const [sub, ...rest] = args;
  const print = (workspace: Workspace, verb: string) =>
    deps.out(json ? JSON.stringify(workspace) : `${verb} ${workspaceLine(workspace)}`);

  if (sub === "list") {
    const { positional, options } = parseArgs(rest, ["project", "state"]);
    if (positional.length > 0) throw usageError("ws list takes no positional arguments");
    const query = new URLSearchParams();
    if (options.project) query.set("projectId", (await api.project(options.project)).id);
    if (options.state) query.set("state", options.state);
    const { workspaces } = await api.call("GET", `workspaces?${query}`, WorkspaceList);
    if (json) return deps.out(JSON.stringify(workspaces));
    if (workspaces.length === 0) return deps.out("No workspaces.");
    for (const workspace of workspaces) deps.out(workspaceLine(workspace));
    return;
  }
  if (sub === "new") {
    const { positional, options } = parseArgs(rest, ["mode", "line", "base"]);
    if (positional.length < 2) throw usageError("ws new takes a project and a name");
    const mode = (options.mode ?? "new") as Isolation;
    if (!MODES.includes(mode)) throw usageError(`--mode must be one of ${MODES.join(", ")}`);
    const project = await api.project(positional[0] as string);
    const result = await api.call("POST", "workspaces", CreateWorkspaceResponse, {
      projectId: project.id,
      name: positional.slice(1).join(" "),
      isolation: mode,
      ...(options.line ? { line: options.line } : {}),
      ...(options.base ? { base: options.base } : {}),
    });
    if (json) deps.out(JSON.stringify(result));
    else {
      for (const warning of result.warnings) deps.err(`warning: ${warning}`);
      print(result.workspace, "Created");
      if (result.copied.length > 0) deps.out(`Copied: ${result.copied.join(", ")}`);
    }
    return reportSteps(deps, result.steps, json);
  }
  if (sub === "rename" && rest.length >= 2) {
    const [id, ...name] = rest;
    const { workspace } = await api.call("PATCH", `workspaces/${id}`, WorkspaceBody, {
      name: name.join(" "),
    });
    return print(workspace, "Renamed");
  }
  if ((sub === "park" || sub === "resume") && rest.length === 1) {
    const { workspace } = await api.call("POST", `workspaces/${rest[0]}/${sub}`, WorkspaceBody);
    return print(workspace, sub === "park" ? "Parked" : "Resumed");
  }
  if (sub === "archive") {
    const { positional, on } = parseArgs(rest, [], ["force"]);
    if (positional.length !== 1) throw usageError("ws archive takes one workspace id");
    const result = await api.call(
      "POST",
      `workspaces/${positional[0]}/archive`,
      ArchiveWorkspaceResponse,
      {
        ...(on.has("force") ? { force: true } : {}),
      },
    );
    if (json) deps.out(JSON.stringify(result));
    else print(result.workspace, "Archived");
    return reportSteps(deps, result.steps, json);
  }
  throw usageError(`Unknown command: ws ${args.join(" ")}`);
}

/** Prints what setup or teardown did. A failed step exits 1, though the workspace change happened. */
function reportSteps(deps: CliDeps, steps: readonly StepReport[], json: boolean): void {
  const failed = steps.filter((step) => !step.ok);
  if (!json) for (const step of steps.filter((candidate) => candidate.ok)) deps.out(step.message);
  if (failed.length > 0) throw new CliError(failed.map((step) => step.message).join("\n"), 1);
}

const ActionRunBody = Type.Object({ run: ActionRun });

async function actionCommand(
  api: Api,
  deps: CliDeps,
  args: string[],
  json: boolean,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list" && rest.length === 1) {
    const { actions } = await api.call("GET", `actions/workspaces/${rest[0]}`, ActionList);
    if (json) return deps.out(JSON.stringify(actions));
    if (actions.length === 0) return deps.out("No actions in .pi-spore/config.toml.");
    for (const action of actions) {
      const command = typeof action.run === "string" ? `sh -c ${action.run}` : action.run.join(" ");
      const flags = action.exclusive ? "  [exclusive]" : "";
      deps.out(`${action.name.padEnd(16)} ${command}  (${action.source})${flags}`);
    }
    return;
  }
  if (sub === "run" && rest.length === 2) {
    const { run: started } = await api.call(
      "POST",
      `actions/workspaces/${rest[0]}/runs`,
      ActionRunBody,
      { action: rest[1] },
    );
    if (!json) deps.err(`Run ${started.id} (${started.status}), log: ${started.logPath}`);
    // The server holds each request until there is new output or the run ends, so this loop does not spin.
    let from = 0;
    let run = started;
    for (;;) {
      const log = await api.call(
        "GET",
        `actions/runs/${started.id}/log?from=${from}&wait=15000`,
        ActionLog,
      );
      if (!json) deps.write(log.text);
      from = log.end;
      run = log.run;
      if (run.status !== "queued" && run.status !== "running" && log.end >= log.size) break;
    }
    if (json) deps.out(JSON.stringify(run));
    if (run.status !== "succeeded") {
      const how =
        run.exitCode !== undefined ? `exit code ${run.exitCode}` : (run.error ?? run.status);
      throw new CliError(`Action ${run.action} ${run.status} (${how})`, 1);
    }
    return;
  }
  if (sub === "cancel" && rest.length === 1) {
    const { run } = await api.call("POST", `actions/runs/${rest[0]}/cancel`, ActionRunBody);
    return deps.out(json ? JSON.stringify(run) : `Run ${run.id} ${run.status}`);
  }
  throw usageError(`Unknown command: action ${args.join(" ")}`);
}

/** Runs one CLI invocation and returns the process exit code. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = argv.filter((arg) => arg !== "--json");
  const json = args.length !== argv.length;
  const [command, ...rest] = args;
  const base = deps.env.PI_SPORE_URL ?? DEFAULT_URL;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    deps.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    if (command === "health" && rest.length === 0) await health(deps, base, json);
    else if (command === "project") await projectCommand(new Api(deps, base), deps, rest, json);
    else if (command === "ws" || command === "workspace")
      await workspaceCommand(new Api(deps, base), deps, rest, json);
    else if (command === "action") await actionCommand(new Api(deps, base), deps, rest, json);
    else throw usageError(`Unknown command: ${args.join(" ")}`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      deps.err(error.message);
      return error.code;
    }
    throw error;
  }
}
