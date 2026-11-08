// A stand-in for a gate action. Usage: gate-action.mjs <counter file> <label> <mode>
// Every run appends its label as one line to the counter file, so a test counts how often it ran. Modes:
//   pass        exits 0
//   fail        prints "gate output: boom" and exits 1
//   hang-first  the first run of this label hangs until killed (so a test can cut it off with a restart); later
//               runs of the label exit 0. A hung run ends by itself after two minutes.
import { appendFileSync, readFileSync } from "node:fs";

const [counter, label, mode] = process.argv.slice(2);
appendFileSync(counter, `${label}\n`);

if (mode === "fail") {
  console.log("gate output: boom");
  process.exit(1);
}
if (mode === "hang-first") {
  const runs = readFileSync(counter, "utf8")
    .split("\n")
    .filter((line) => line === label);
  if (runs.length === 1) {
    console.log("waiting");
    setTimeout(() => process.exit(1), 120_000);
    setInterval(() => {}, 1_000);
  }
} else if (mode !== "pass") {
  console.error(`gate-action.mjs: unknown mode ${mode}`);
  process.exit(64);
}
