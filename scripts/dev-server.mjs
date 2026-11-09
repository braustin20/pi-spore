// A throwaway pi-spore server for agent work: it builds, then runs on a temp home and a free port, so it can
// never read or stop the real install. Project actions inherit the real server's environment, so the child's
// PI_SPORE_HOME, PI_SPORE_PORT, PI_SPORE_URL, PI_SPORE_TOKEN and PI_SPORE_SERVER_PID are set on purpose here.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves with a child's exit code, or null when a signal ended it. */
const exited = (child) => new Promise((resolve) => child.once("exit", (code) => resolve(code)));

const built = await exited(spawn("npm", ["run", "build"], { stdio: "inherit" }));
if (built !== 0) process.exit(built ?? 1);

const home = await mkdtemp(join(tmpdir(), "pi-spore-dev-"));

// Port 0 is handed out only when free, so the probe is closed before the server gets the number.
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const found = probe.address().port;
    probe.close(() => resolve(found));
  });
});

const env = { ...process.env, PI_SPORE_HOME: home, PI_SPORE_PORT: String(port) };
for (const key of ["PI_SPORE_URL", "PI_SPORE_TOKEN", "PI_SPORE_SERVER_PID"]) delete env[key];

const url = `http://127.0.0.1:${port}`;
console.log(`pi-spore dev server: ${url} (home ${home}, token in ${join(home, "token")})`);

const serverEntry = fileURLToPath(new URL("../packages/server/dist/main.js", import.meta.url));
const child = spawn(process.execPath, [serverEntry], { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    // The action runner may have already signalled this process group; forward once, ignore a gone child.
    try {
      if (child.pid !== undefined) process.kill(child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
}

const code = await exited(child);
await rm(home, { recursive: true, force: true });
process.exit(code ?? 1);
