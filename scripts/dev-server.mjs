// A workspace's own pi-spore server, for the user and for agents that work on pi-spore: it builds, then runs the
// worktree's server on a free port. The home is <worktree>/.pi-spore-dev/home and is kept between runs, so test
// data survives restarts. Delete .pi-spore-dev/ to reset. The server never touches ~/.pi-spore: devEnv sets its
// own home and drops the outer server's PI_SPORE_* names. The sample project is its own git repo, because a project
// that shared .git with the real repo would show the dev server's branches there (ADR 0161). Once the server is
// ready, its URL goes to <worktree>/.pi-spore-dev/url, for scripts/screenshot.mjs (ADR 0172).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { devEnv, ensureSampleProject, ensureSampleRepo, freePort } from "./dev-server-lib.mjs";

const worktree = dirname(dirname(fileURLToPath(import.meta.url)));
const devRoot = join(worktree, ".pi-spore-dev");
const home = join(devRoot, "home");
const sampleRepo = join(devRoot, "sample-repo");

/** Resolves with a child's exit code, or null when a signal ended it. */
const exited = (child) => new Promise((resolve) => child.once("exit", (code) => resolve(code)));

const built = await exited(spawn("npm", ["run", "build"], { stdio: "inherit", cwd: worktree }));
if (built !== 0) process.exit(built ?? 1);

await mkdir(home, { recursive: true });
const port = await freePort();
const url = `http://127.0.0.1:${port}/`;

const serverEntry = join(worktree, "packages/server/dist/main.js");
const child = spawn(process.execPath, [serverEntry], {
  stdio: "inherit",
  env: devEnv(process.env, home, port),
});
let childCode;
const childDone = exited(child).then((code) => {
  childCode = code ?? 1;
  return childCode;
});

/** Sends a signal to the server. The action runner may have signalled this process group already, so a gone child is fine. */
const signalChild = (signal) => {
  try {
    if (child.pid !== undefined) process.kill(child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => signalChild(signal));

/** Polls /api/health until it answers 200. Throws when the server exits or 30 s pass. */
const waitForHealth = async () => {
  const deadline = Date.now() + 30_000;
  while (childCode === undefined) {
    if (Date.now() > deadline)
      throw new Error(`Server did not answer ${url}api/health within 30 s`);
    const ok = await fetch(`${url}api/health`).then(
      (response) => response.status === 200,
      () => false,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`Server exited with code ${childCode} before it answered ${url}api/health`);
};

try {
  await waitForHealth();
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  await ensureSampleRepo(sampleRepo);
  await ensureSampleProject(url, token, sampleRepo);
  // The port is random, so tools that look at this server need a place to find it.
  await writeFile(join(devRoot, "url"), `${url}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  signalChild("SIGTERM");
  await childDone;
  process.exit(1);
}

console.log(`pi-spore dev server: ${url}`);
process.exit(await childDone);
