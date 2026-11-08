import { readFileSync } from "node:fs";
import {
  ActionList,
  ActionLog,
  ActionRun,
  type Agent,
  AgentList,
  Agent as AgentSchema,
  type Approval,
  ApprovalList,
  Approval as ApprovalSchema,
  ArchiveWorkspaceResponse,
  CARD_COLUMNS,
  CalibrationResponse,
  type Card,
  type CardColumn,
  CardList,
  Card as CardSchema,
  CreateWorkspaceResponse,
  DEFAULT_URL,
  DiffList,
  type FileDiff,
  HealthResponse,
  type Isolation,
  Job,
  JobList,
  JobState,
  PipelineList,
  type PipelineRun,
  PipelineRunList,
  PipelineRun as PipelineRunSchema,
  type PipelineTurn,
  Project,
  ProjectList,
  PrStatus,
  parse,
  type Run,
  RunList,
  Run as RunSchema,
  StartCardResponse,
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
  ws diff <id> [--staged | --commits | --commit <id>]
                                           Show the workspace's changes: uncommitted (default), staged,
                                           all commits since its base, or one commit
  action list <workspace>                  List a workspace's actions
  action run <workspace> <name>            Run an action and follow its log; exits 1 if it fails
  action cancel <run id>
  chat list <workspace>                    List a workspace's chats: the active worker chat, side chats,
                                           then older worker chats
  chat new <workspace> [--side [--fork]]   Start a fresh worker chat (the current one stops and stays
                                           readable), or a read-only side chat; --fork copies the
                                           worker chat's context into it
  card list [--project <project>] [--label <label>]
  card add <title> [--project <project>] [--due YYYY-MM-DD] [--label <label>] [--column <column>]
  card move <card> <column>                backlog, ready, in-progress, review, or done
  card rm <card>
  card start <card> --new [--mode new|existing|in-place] [--line <branch>] [--base <branch>]
  card start <card> --workspace <workspace>
                                           Start work from a card in a new workspace or an active one of
                                           its project; the brief goes to its worker chat. Add
                                           --blocked-ok to start a blocked card
  approvals list [--all]                   Open approvals agents asked for; --all includes decided ones
  approvals approve <approval>
  approvals decline <approval> [--note <text>]
  jobs [--all]                             Background jobs that have not ended; --all includes ended ones
  jobs retry <job>                         Run an interrupted or waiting job again now
  jobs cancel <job>
  pipeline list <workspace>                Pipelines the workspace can start; a broken one shows its error
  pipeline start <workspace> <pipeline> (--brief <text> | --brief-file <path>)
                                           Start a run; a workspace has one active run at a time
  pipeline runs <workspace>                The workspace's runs, newest first
  pipeline show <run>                      A run's stages, turns, verdicts, and findings
  pipeline cancel <run>
  pipeline retry <run>                     Run a stuck run's step again now, after fixing what blocked it
  run start <project> <name> [--base <branch>] [--gate <action>]...
                                           Start a run: a run workspace and a coordinator chat. Default
                                           gates: check and test
  run list [--project <project>]           Runs, newest first
  run show <run>                           A run's lanes by wave, with state and workspace
  usage calibration                        Routing calibration (ADR 0144): how Jev's answers spread, how
                                           local runs turned out, and a suggested bar. Never changes it
  pr status <workspace>                    Show the workspace's PR, its checks, and the watch
  pr open <workspace> [--title <t>] [--body <b>] [--base <branch>] [--draft]
                                           Push the branch and open a PR on GitHub (outward-facing)
  pr push <workspace>                      Push new commits to the PR's branch (never forced)
  pr watch <workspace> on|off              Send failed checks to the worker, or stop

<project> is a project id or slug. <workspace>, <card>, <approval>, <job>, and <run> are ids.

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
  repeated: readonly string[] = [],
) {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const on = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (switches.includes(name)) on.add(name);
    else if (repeated.includes(name)) {
      const value = args[++i];
      if (value === undefined) throw usageError(`--${name} needs a value`);
      lists[name] = [...(lists[name] ?? []), value];
    } else if (flags.includes(name)) {
      const value = args[++i];
      if (value === undefined) throw usageError(`--${name} needs a value`);
      options[name] = value;
    } else throw usageError(`Unknown option ${arg}`);
  }
  return { positional, options, on, lists };
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
  if (sub === "diff") {
    const { positional, options, on } = parseArgs(rest, ["commit"], ["staged", "commits"]);
    if (positional.length !== 1) throw usageError("ws diff takes one workspace id");
    const picked = [on.has("staged"), on.has("commits"), options.commit !== undefined].filter(
      Boolean,
    );
    if (picked.length > 1) throw usageError("Use one of --staged, --commits, and --commit");
    const query = new URLSearchParams();
    if (on.has("staged")) query.set("scope", "staged");
    if (on.has("commits")) query.set("scope", "line");
    if (options.commit) {
      query.set("scope", "record");
      query.set("record", options.commit);
    }
    const result = await api.call(
      "GET",
      `changes/workspaces/${positional[0]}/diff?${query}`,
      DiffList,
    );
    if (json) return deps.out(JSON.stringify(result));
    if (result.diffs.length === 0) return deps.out("No changes.");
    for (const diff of result.diffs) printDiff(deps, diff);
    if (result.truncated) deps.err("More files changed than shown.");
    return;
  }
  throw usageError(`Unknown command: ws ${args.join(" ")}`);
}

const STATUS_LETTERS = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

/** One file's diff in the usual unified form, with a header line of status, path, and counts. */
function printDiff(deps: CliDeps, diff: FileDiff): void {
  const { file } = diff;
  const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  deps.out(`${STATUS_LETTERS[file.status]} ${path}  +${file.additions} -${file.deletions}`);
  if (diff.note === "binary") deps.out("  (binary file)");
  if (diff.note === "too_large") deps.out("  (too large to show)");
  for (const hunk of diff.hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "del").length;
    deps.out(
      `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.section ? ` ${hunk.section}` : ""}`,
    );
    for (const line of hunk.lines) {
      deps.out(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
      if (line.noNewline) deps.out("\\ No newline at end of file");
    }
  }
  deps.out("");
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

const AgentBody = Type.Object({ agent: AgentSchema });

function chatLine(chat: Agent): string {
  const kind = chat.kind !== "worker" ? chat.kind : chat.active ? "worker" : "older";
  const from = chat.forkedFrom ? `  (from ${chat.forkedFrom})` : "";
  return `${chat.id}  ${kind.padEnd(6)}  ${chat.status.padEnd(8)}  ${chat.title ?? "(no messages yet)"}${from}`;
}

async function chatCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const { positional } = parseArgs(rest, []);
    if (positional.length !== 1) throw usageError("chat list takes one workspace id");
    const { agents } = await api.call(
      "GET",
      `agents?workspaceId=${encodeURIComponent(positional[0] as string)}`,
      AgentList,
    );
    if (json) return deps.out(JSON.stringify(agents));
    if (agents.length === 0)
      return deps.out("No chats yet. Start one: pi-spore chat new <workspace>");
    for (const chat of agents) deps.out(chatLine(chat));
    return;
  }
  if (sub === "new") {
    const { positional, on } = parseArgs(rest, [], ["side", "fork"]);
    if (positional.length !== 1) throw usageError("chat new takes one workspace id");
    if (on.has("fork") && !on.has("side")) throw usageError("--fork needs --side");
    const { agent } = await api.call("POST", "agents/chats", AgentBody, {
      workspaceId: positional[0],
      kind: on.has("side") ? "side" : "worker",
      ...(on.has("fork") ? { fork: true } : {}),
    });
    return deps.out(json ? JSON.stringify(agent) : `Started ${chatLine(agent)}`);
  }
  throw usageError(`Unknown command: chat ${args.join(" ")}`);
}

const CardBody = Type.Object({ card: CardSchema });

function cardLine(card: Card, projects: readonly Project[]): string {
  const project = card.projectId
    ? (projects.find((candidate) => candidate.id === card.projectId)?.slug ?? card.projectId)
    : "-";
  const extras = [
    card.due ? `due ${card.due}` : "",
    card.labels.length ? `[${card.labels.join(", ")}]` : "",
    card.blocked ? "blocked" : "",
  ].filter((extra) => extra !== "");
  return `${card.id}  ${card.column.padEnd(11)} ${project.padEnd(16)} ${card.title}${extras.length ? `  ${extras.join("  ")}` : ""}`;
}

function columnArg(value: string): CardColumn {
  if (!(CARD_COLUMNS as readonly string[]).includes(value)) {
    throw usageError(`The column must be one of ${CARD_COLUMNS.join(", ")}`);
  }
  return value as CardColumn;
}

async function cardCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  const projects = async () => (await api.call("GET", "projects", ProjectList)).projects;
  if (sub === "list") {
    const { positional, options } = parseArgs(rest, ["project", "label"]);
    if (positional.length > 0) throw usageError("card list takes no positional arguments");
    const query = new URLSearchParams();
    if (options.project) query.set("projectId", (await api.project(options.project)).id);
    if (options.label) query.set("label", options.label);
    const { cards } = await api.call("GET", `kanban/cards?${query}`, CardList);
    if (json) return deps.out(JSON.stringify(cards));
    if (cards.length === 0) return deps.out("No cards.");
    const known = await projects();
    for (const card of cards) deps.out(cardLine(card, known));
    return;
  }
  if (sub === "add") {
    const { positional, options } = parseArgs(rest, ["project", "due", "label", "column"]);
    if (positional.length === 0) throw usageError("card add takes a title");
    const project = options.project ? await api.project(options.project) : undefined;
    const { card } = await api.call("POST", "kanban/cards", CardBody, {
      title: positional.join(" "),
      ...(project ? { projectId: project.id } : {}),
      ...(options.due ? { due: options.due } : {}),
      ...(options.label ? { labels: [options.label] } : {}),
      ...(options.column ? { column: columnArg(options.column) } : {}),
    });
    return deps.out(
      json ? JSON.stringify(card) : `Added ${cardLine(card, project ? [project] : [])}`,
    );
  }
  if (sub === "move" && rest.length === 2) {
    const column = columnArg(rest[1] as string);
    const { card } = await api.call("POST", `kanban/cards/${rest[0]}/move`, CardBody, { column });
    return deps.out(json ? JSON.stringify(card) : `Moved ${cardLine(card, await projects())}`);
  }
  if (sub === "rm" && rest.length === 1) {
    await api.call("DELETE", `kanban/cards/${rest[0]}`, Type.Object({ removed: Type.String() }));
    return deps.out(json ? JSON.stringify({ removed: rest[0] }) : `Removed card ${rest[0]}`);
  }
  if (sub === "start") {
    const { positional, options, on } = parseArgs(
      rest,
      ["workspace", "mode", "line", "base"],
      ["new", "blocked-ok"],
    );
    if (positional.length !== 1) throw usageError("card start takes one card id");
    if (on.has("new") === (options.workspace !== undefined))
      throw usageError("card start needs either --new or --workspace <id>");
    if (options.workspace && (options.mode || options.line || options.base))
      throw usageError("--mode, --line, and --base go with --new only");
    const mode = (options.mode ?? "new") as Isolation;
    if (!MODES.includes(mode)) throw usageError(`--mode must be one of ${MODES.join(", ")}`);
    const request = options.workspace
      ? { workspaceId: options.workspace }
      : {
          isolation: mode,
          ...(options.line ? { line: options.line } : {}),
          ...(options.base ? { base: options.base } : {}),
        };
    const result = await api.call(
      "POST",
      `kanban/cards/${positional[0]}/start`,
      StartCardResponse,
      {
        ...request,
        ...(on.has("blocked-ok") ? { confirmBlocked: true } : {}),
      },
    );
    if (json) return deps.out(JSON.stringify(result));
    for (const warning of result.created?.warnings ?? []) deps.err(`warning: ${warning}`);
    deps.out(`Started ${cardLine(result.card, await projects())}`);
    deps.out(`In ${workspaceLine(result.workspace)}`);
    deps.out(`Brief sent to chat ${result.chatId}`);
    return reportSteps(deps, result.created?.steps ?? [], json);
  }
  throw usageError(`Unknown command: card ${args.join(" ")}`);
}

const ApprovalBody = Type.Object({ approval: ApprovalSchema });

function approvalLine(approval: Approval): string {
  const state = approval.state === "open" ? "" : `  ${approval.state}`;
  return `${approval.id}  ${approval.title}${state}\n    reason: ${approval.reason}`;
}

async function approvalsCommand(
  api: Api,
  deps: CliDeps,
  args: string[],
  json: boolean,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const { positional, on } = parseArgs(rest, [], ["all"]);
    if (positional.length > 0) throw usageError("approvals list takes no positional arguments");
    const { approvals } = await api.call(
      "GET",
      `attention/approvals${on.has("all") ? "" : "?state=open"}`,
      ApprovalList,
    );
    if (json) return deps.out(JSON.stringify(approvals));
    if (approvals.length === 0) return deps.out("No approvals waiting.");
    for (const approval of approvals) deps.out(approvalLine(approval));
    return;
  }
  if (sub === "approve" && rest.length === 1) {
    const { approval } = await api.call(
      "POST",
      `attention/approvals/${rest[0]}/approve`,
      ApprovalBody,
      {},
    );
    return deps.out(
      json ? JSON.stringify(approval) : `Approved ${approval.id}: ${approval.outcome ?? ""}`,
    );
  }
  if (sub === "decline") {
    const { positional, options } = parseArgs(rest, ["note"]);
    if (positional.length !== 1) throw usageError("approvals decline takes one approval id");
    const { approval } = await api.call(
      "POST",
      `attention/approvals/${positional[0]}/decline`,
      ApprovalBody,
      options.note ? { note: options.note } : {},
    );
    return deps.out(json ? JSON.stringify(approval) : `Declined ${approval.id}`);
  }
  throw usageError(`Unknown command: approvals ${args.join(" ")}`);
}

function jobLine(job: Job): string {
  return `${job.id}  ${job.kind}  ${job.state}  ${job.step}${job.error ? `  ${job.error}` : ""}`;
}

async function jobsCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "retry" || sub === "cancel") {
    if (rest.length !== 1) throw usageError(`jobs ${sub} takes one job id`);
    const job = await api.call("POST", `jobs/${rest[0]}/${sub}`, Job, {});
    return deps.out(json ? JSON.stringify(job) : `${job.id} is now ${job.state}`);
  }
  const { positional, on } = parseArgs(args, [], ["all"]);
  if (positional.length > 0) throw usageError(`Unknown command: jobs ${args.join(" ")}`);
  const query = on.has("all")
    ? `?${JobState.anyOf.map((state) => `state=${state.const}`).join("&")}`
    : "";
  const { jobs } = await api.call("GET", `jobs${query}`, JobList);
  if (json) return deps.out(JSON.stringify(jobs));
  if (jobs.length === 0) return deps.out("No jobs.");
  for (const job of jobs) deps.out(jobLine(job));
}

const RunBody = Type.Object({ run: PipelineRunSchema });

function runLine(run: PipelineRun): string {
  const stage = run.stages[run.stageIndex]?.name ?? "-";
  const note = run.blocked ? `  blocked: ${run.blocked}` : run.message ? `  ${run.message}` : "";
  return `${run.id}  ${run.state.padEnd(12)} ${run.pipelineId}  stage ${stage}${note.split("\n")[0]}`;
}

function turnLines(turn: PipelineTurn): string[] {
  const { report } = turn;
  const lines = [
    `  ${turn.kind} round ${turn.round}  ${turn.role}  chat ${turn.agentId}  ${report ? (report.verdict ?? "reported") : "waiting for report"}`,
  ];
  if (!report) return lines;
  lines.push(`    ${report.summary.split("\n").join("\n    ")}`);
  for (const severity of ["blocking", "important", "minor"] as const) {
    for (const finding of (report.findings ?? []).filter((found) => found.severity === severity)) {
      const where = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
        : "";
      lines.push(`    ${severity}: ${finding.title}${where}`);
    }
  }
  for (const test of report.tests ?? []) lines.push(`    test: ${test.name}  proof ${test.proof}`);
  if (report.earlyStop) {
    const { stop, probability, error } = report.earlyStop;
    const chance = probability === undefined ? "" : ` (${Math.round(probability * 100)}%)`;
    lines.push(`    Jev: ${stop ? "stop" : "go on"}${chance}${error ? `  ${error}` : ""}`);
  }
  return lines;
}

function printRun(deps: CliDeps, run: PipelineRun): void {
  deps.out(`Run ${run.id}  ${run.pipelineId} (${run.source})  ${run.state}`);
  deps.out(`Workspace ${run.workspaceId}`);
  if (run.message) deps.out(`Message: ${run.message}`);
  if (run.blocked)
    deps.out(`Blocked: ${run.blocked}\nFix it, then: pi-spore pipeline retry ${run.id}`);
  run.stages.forEach((stage, index) => {
    deps.out("");
    deps.out(`Stage ${stage.name}${index === run.stageIndex ? "  (current)" : ""}`);
    const turns = run.turns.filter((turn) => turn.stageIndex === index);
    if (turns.length === 0 && stage.gates) deps.out(`  gates: ${stage.gates.join(", ")}`);
    for (const turn of turns) for (const line of turnLines(turn)) deps.out(line);
  });
}

async function pipelineCommand(
  api: Api,
  deps: CliDeps,
  args: string[],
  json: boolean,
): Promise<void> {
  const [sub, ...rest] = args;
  const show = (run: PipelineRun, verb: string) =>
    deps.out(json ? JSON.stringify(run) : `${verb} ${runLine(run)}`);
  if (sub === "list" && rest.length === 1) {
    const { pipelines } = await api.call("GET", `pipelines/workspaces/${rest[0]}`, PipelineList);
    if (json) return deps.out(JSON.stringify(pipelines));
    if (pipelines.length === 0) return deps.out("No pipelines.");
    for (const pipeline of pipelines) {
      const what = pipeline.error
        ? `error: ${pipeline.error}`
        : (pipeline.stages ?? []).map((stage) => stage.name).join(" > ");
      deps.out(`${pipeline.id.padEnd(20)} ${pipeline.source.padEnd(9)} ${what}`);
    }
    return;
  }
  if (sub === "start") {
    const { positional, options } = parseArgs(rest, ["brief", "brief-file"]);
    if (positional.length !== 2)
      throw usageError("pipeline start takes a workspace and a pipeline");
    if ((options.brief === undefined) === (options["brief-file"] === undefined))
      throw usageError("pipeline start needs --brief <text> or --brief-file <path>");
    const brief = options.brief ?? readBriefFile(deps.resolvePath(options["brief-file"] as string));
    const { run } = await api.call("POST", `pipelines/workspaces/${positional[0]}/runs`, RunBody, {
      pipeline: positional[1],
      brief,
    });
    return show(run, "Started");
  }
  if (sub === "runs" && rest.length === 1) {
    const { runs } = await api.call("GET", `pipelines/workspaces/${rest[0]}/runs`, PipelineRunList);
    if (json) return deps.out(JSON.stringify(runs));
    if (runs.length === 0) return deps.out("No runs.");
    for (const run of runs) deps.out(runLine(run));
    return;
  }
  if (sub === "show" && rest.length === 1) {
    const { run } = await api.call("GET", `pipelines/runs/${rest[0]}`, RunBody);
    return json ? deps.out(JSON.stringify(run)) : printRun(deps, run);
  }
  if ((sub === "cancel" || sub === "retry") && rest.length === 1) {
    const { run } = await api.call("POST", `pipelines/runs/${rest[0]}/${sub}`, RunBody, {});
    return show(run, sub === "cancel" ? "Cancelled" : "Retried");
  }
  throw usageError(`Unknown command: pipeline ${args.join(" ")}`);
}

/** "23/30 (77%)": the sample size sits next to the share. */
const share = (count: number, total: number) =>
  `${count}/${total}${total > 0 ? ` (${Math.round((count / total) * 100)}%)` : ""}`;

const TOO_LITTLE = "  too little data";

async function usageCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  if (args.length !== 1 || args[0] !== "calibration")
    throw usageError(`Unknown command: usage ${args.join(" ")}`);
  const report = await api.call("GET", "usage/calibration", CalibrationResponse);
  if (json) return deps.out(JSON.stringify(report));
  deps.out(
    `Bar now ${report.threshold}. ${report.decisions} decisions with Jev answers, ${report.outcomes} local outcomes.`,
  );
  deps.out(
    report.suggestedBar === undefined
      ? `Suggested bar: none (no bar has ${report.minSample} local outcomes with 90% passed)`
      : `Suggested bar: ${report.suggestedBar}`,
  );
  deps.out(`${"bar".padEnd(5)}${"would go local".padEnd(17)}passed`);
  for (const bar of report.bars) {
    const passed = `${share(bar.passed, bar.localOutcomes)}${bar.enough ? "" : TOO_LITTLE}`;
    deps.out(
      `${String(bar.bar).padEnd(5)}${share(bar.wouldGoLocal, bar.decisions).padEnd(17)}${passed}`,
    );
  }
  for (const [question, buckets] of Object.entries(report.buckets)) {
    deps.out(question);
    for (const bucket of buckets) {
      const range = `${bucket.from.toFixed(1)}-${bucket.to.toFixed(1)}`;
      const passed = `${share(bucket.passed, bucket.localOutcomes)}${bucket.enough ? "" : TOO_LITTLE}`;
      deps.out(`  ${range}  ${`answers ${bucket.answers}`.padEnd(12)}passed ${passed}`);
    }
  }
}

const CoordinatedRunBody = Type.Object({ run: RunSchema });

function laneLines(run: Run): string[] {
  return run.lanes.map((lane) => {
    const where = lane.workspaceId ? `  workspace ${lane.workspaceId}` : "";
    const note = lane.message ? `  ${lane.message.split("\n")[0]}` : "";
    return `  wave ${lane.wave}  ${lane.state.padEnd(9)} ${lane.name}${where}${note}`;
  });
}

async function runCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "start") {
    const { positional, options, lists } = parseArgs(rest, ["base"], [], ["gate"]);
    if (positional.length !== 2) throw usageError("run start takes a project and a name");
    const project = await api.project(positional[0] as string);
    const { run } = await api.call("POST", "runs", CoordinatedRunBody, {
      projectId: project.id,
      name: positional[1],
      ...(options.base ? { base: options.base } : {}),
      ...(lists.gate ? { gates: lists.gate } : {}),
    });
    return deps.out(
      json
        ? JSON.stringify(run)
        : `Started run ${run.id}  ${run.line}  from ${run.base}\nWorkspace ${run.workspaceId}`,
    );
  }
  if (sub === "list") {
    const { positional, options } = parseArgs(rest, ["project"]);
    if (positional.length > 0) throw usageError("run list takes no positional arguments");
    const query = new URLSearchParams();
    if (options.project) query.set("projectId", (await api.project(options.project)).id);
    const { runs } = await api.call("GET", `runs?${query}`, RunList);
    if (json) return deps.out(JSON.stringify(runs));
    if (runs.length === 0) return deps.out("No runs.");
    for (const run of runs) deps.out(`${run.id}  ${run.line}  ${run.lanes.length} lanes`);
    return;
  }
  if (sub === "show" && rest.length === 1) {
    const { run } = await api.call("GET", `runs/${rest[0]}`, CoordinatedRunBody);
    if (json) return deps.out(JSON.stringify(run));
    deps.out(`Run ${run.id}  ${run.line}  from ${run.base}`);
    deps.out(`Workspace ${run.workspaceId}  gates: ${run.gates.join(", ")}`);
    if (run.lanes.length === 0) return deps.out("No lanes.");
    for (const line of laneLines(run)) deps.out(line);
    for (const question of run.questions) deps.out(`Open question: ${question.question}`);
    return;
  }
  throw usageError(`Unknown command: run ${args.join(" ")}`);
}

/** The only file read in the CLI; a missing file is an error that names the path. */
function readBriefFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read the brief file ${path}: ${(error as Error).message}`, 1);
  }
}

function printPr(deps: CliDeps, status: PrStatus): void {
  const { pr, watch } = status;
  if (!pr) {
    deps.out(
      status.publishable
        ? `No PR yet. Open one: pi-spore pr open ${status.workspaceId}`
        : `No PR. ${status.reason ?? ""}`.trim(),
    );
    return;
  }
  deps.out(`#${pr.number} ${pr.draft ? "draft" : pr.state}  ${pr.line} -> ${pr.base}  ${pr.url}`);
  deps.out(`  ${pr.title}`);
  const mergeable = pr.mergeable === "conflicting" ? `conflicts with ${pr.base}` : pr.mergeable;
  deps.out(`Review: ${pr.review.replace("_", " ")}   Mergeable: ${mergeable}`);
  if (status.local.headId && status.local.headId !== pr.headId) {
    deps.out("Local commits differ from the PR. Push them: pi-spore pr push <workspace>");
  }
  if (status.local.uncommitted > 0) {
    deps.out(`${status.local.uncommitted} uncommitted files are not in the PR.`);
  }
  if (pr.checks.length === 0) deps.out("Checks: none");
  else {
    deps.out("Checks:");
    for (const check of pr.checks) {
      const name = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
      deps.out(`  ${check.state.padEnd(9)} ${name}${check.url ? `  ${check.url}` : ""}`);
    }
  }
  const tries =
    watch.state === "off" || watch.state === "done"
      ? ""
      : `  tries ${watch.tries}/${watch.maxTries}`;
  deps.out(`Watch: ${watch.state === "waiting" ? "waiting for you" : watch.state}${tries}`);
  if (watch.message) deps.out(`  ${watch.message}`);
}

async function prCommand(api: Api, deps: CliDeps, args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  const show = (status: PrStatus) =>
    json ? deps.out(JSON.stringify(status)) : printPr(deps, status);
  if (sub === "status" && rest.length === 1) {
    return show(await api.call("GET", `github-pr/workspaces/${rest[0]}?refresh=1`, PrStatus));
  }
  if (sub === "open") {
    const { positional, options, on } = parseArgs(rest, ["title", "body", "base"], ["draft"]);
    if (positional.length !== 1) throw usageError("pr open takes one workspace id");
    const id = positional[0] as string;
    const { defaults } = await api.call("GET", `github-pr/workspaces/${id}`, PrStatus);
    const base = options.base ?? defaults.base;
    if (!base) throw new CliError("The workspace has no base branch. Give one with --base.", 1);
    const status = await api.call("POST", `github-pr/workspaces/${id}/publish`, PrStatus, {
      title: options.title ?? defaults.title,
      body: options.body ?? defaults.body,
      base,
      ...(on.has("draft") ? { draft: true } : {}),
      confirm: true,
    });
    return show(status);
  }
  if (sub === "push" && rest.length === 1) {
    return show(
      await api.call("POST", `github-pr/workspaces/${rest[0]}/push`, PrStatus, { confirm: true }),
    );
  }
  if (sub === "watch" && rest.length === 2 && (rest[1] === "on" || rest[1] === "off")) {
    return show(
      await api.call("POST", `github-pr/workspaces/${rest[0]}/watch`, PrStatus, {
        on: rest[1] === "on",
      }),
    );
  }
  throw usageError(`Unknown command: pr ${args.join(" ")}`);
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
    else if (command === "chat") await chatCommand(new Api(deps, base), deps, rest, json);
    else if (command === "card") await cardCommand(new Api(deps, base), deps, rest, json);
    else if (command === "approvals") await approvalsCommand(new Api(deps, base), deps, rest, json);
    else if (command === "jobs") await jobsCommand(new Api(deps, base), deps, rest, json);
    else if (command === "pipeline") await pipelineCommand(new Api(deps, base), deps, rest, json);
    else if (command === "usage") await usageCommand(new Api(deps, base), deps, rest, json);
    else if (command === "run") await runCommand(new Api(deps, base), deps, rest, json);
    else if (command === "pr") await prCommand(new Api(deps, base), deps, rest, json);
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
