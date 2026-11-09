import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The names an outer pi-spore action or agent adds. The dev server must not inherit them.
const INHERITED_NAMES = [
  "PI_SPORE_URL",
  "PI_SPORE_TOKEN",
  "PI_SPORE_SERVER_PID",
  "PI_SPORE_WORKSPACE_ID",
  "PI_SPORE_WORKSPACE_PATH",
  "PI_SPORE_PROJECT_ROOT",
  "PI_SPORE_AGENT_ID",
  "PI_SPORE_CHAT_KIND",
];

/** Returns a copy of `env` that points a server at `home` and `port` and drops the outer server's names. */
export function devEnv(env, home, port) {
  const result = { ...env, PI_SPORE_HOME: home, PI_SPORE_PORT: String(port) };
  for (const name of INHERITED_NAMES) delete result[name];
  return result;
}

/** Resolves with a free port on 127.0.0.1. The probe is closed before the caller gets the number. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const found = probe.address().port;
      probe.close(() => resolve(found));
    });
  });
}

/** Creates a git repo with one commit in `dir` unless `dir` exists. Resolves true when it created it. */
export async function ensureSampleRepo(dir) {
  if (existsSync(dir)) return false;
  await mkdir(dir, { recursive: true });
  const git = (...args) => execFileAsync("git", args, { cwd: dir });
  await git("init", "-b", "main");
  await writeFile(join(dir, "README.md"), "This is the pi-spore dev server's test project.\n");
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=pi-spore",
    "-c",
    "user.email=dev@pi-spore.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Add README",
  );
  return true;
}

/** Adds `path` as a project on the server at `url` (ends with "/") unless it is one already. */
export async function ensureSampleProject(url, token, path) {
  const headers = { authorization: `Bearer ${token}` };
  const request = async (init) => {
    const response = await fetch(`${url}api/projects`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    if (!response.ok) {
      throw new Error(
        `${init.method} ${url}api/projects answered ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  };
  const { projects } = await request({ method: "GET", headers: {} });
  const real = await realpath(path);
  if (projects.some((project) => project.path === real)) return;
  await request({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}
