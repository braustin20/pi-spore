// A stand-in for a gate action. Usage: gate-action.mjs <counter file> <label> <mode>
// Every run appends its label as one line to the counter file, so a test counts how often it ran. Modes:
//   pass        exits 0
//   fail        prints "gate output: boom" and exits 1
//   vitest-fail prints colored vitest-like output with two failed tests (one named twice) and exits 1
//   hang-first  the first run of this label hangs until killed (so a test can cut it off with a restart); later
//               runs of the label exit 0. A hung run ends by itself after two minutes.
import { appendFileSync, readFileSync } from "node:fs";

const [counter, label, mode] = process.argv.slice(2);
appendFileSync(counter, `${label}\n`);

if (mode === "fail") {
  console.log("gate output: boom");
  process.exit(1);
}
if (mode === "vitest-fail") {
  const fail = (name) => `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m ${name}`;
  console.log(fail("src/a.test.ts > adds > one"));
  console.log("\x1b[31m\x1b[1mAssertionError\x1b[22m: expected 1 to be 2\x1b[39m");
  console.log(fail("src/a.test.ts > adds > one"));
  console.log(fail("src/b.test.ts > subtracts"));
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
