import { DEFAULT_URL, HealthResponse, parse } from "@pi-spore/shared";

export interface CliDeps {
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: pi-spore <command> [--json]

Commands:
  health    Show whether the pi-spore server is running

Environment:
  PI_SPORE_URL    Server address (default ${DEFAULT_URL})`;

/** Runs one CLI invocation and returns the process exit code. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = argv.filter((arg) => arg !== "--json");
  const json = args.length !== argv.length;
  const [command, ...rest] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    deps.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "health" || rest.length > 0) {
    deps.err(`Unknown command: ${args.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  return health(deps, json);
}

async function health(deps: CliDeps, json: boolean): Promise<number> {
  const base = deps.env.PI_SPORE_URL ?? DEFAULT_URL;
  const url = new URL("/api/health", base);

  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch (error) {
    deps.err(`pi-spore server is not reachable at ${base}: ${String(error)}`);
    return 1;
  }
  if (!response.ok) {
    deps.err(`pi-spore server at ${base} answered ${response.status} ${response.statusText}`);
    return 1;
  }

  let body: HealthResponse;
  try {
    body = parse(HealthResponse, await response.json(), "health response");
  } catch (error) {
    deps.err(`pi-spore server at ${base} sent a bad health response: ${String(error)}`);
    return 1;
  }

  if (json) {
    deps.out(JSON.stringify(body));
  } else {
    const modules = body.modules.length > 0 ? body.modules.join(", ") : "none";
    deps.out(
      `ok  version ${body.version}  up ${Math.round(body.uptimeMs / 1000)}s  modules: ${modules}`,
    );
  }
  return 0;
}
