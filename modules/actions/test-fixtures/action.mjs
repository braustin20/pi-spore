// A stand-in for a project's action command in tests. Modes:
//   env <file>         writes {cwd, env (PI_SPORE_*), marker} as JSON to <file>
//   say <text>         prints <text> to stdout and "err:<text>" to stderr
//   fail <code>        prints "failing" and exits with <code>
//   hang               prints "started" and runs until killed
//   family <pidfile>   starts a child that runs until killed, writes the child's pid, and hangs
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [mode, arg] = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1_000);

if (mode === "env") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("PI_SPORE_")),
  );
  writeFileSync(arg, JSON.stringify({ cwd: process.cwd(), env, marker: existsSync("marker.txt") }));
  console.log("env written");
} else if (mode === "say") {
  console.log(arg);
  console.error(`err:${arg}`);
} else if (mode === "fail") {
  console.log("failing");
  process.exit(Number(arg));
} else if (mode === "hang") {
  console.log("started");
  forever();
} else if (mode === "family") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(arg, String(child.pid));
  console.log("started");
  forever();
} else {
  console.error(`action.mjs: unknown mode ${mode}`);
  process.exit(64);
}
