// A stand-in for the user's shell in tests. It starts with a line that names what it got:
//   READY cwd=<cwd> size=<cols>x<rows> env=<JSON of PI_SPORE_*, ORCA_*, HERDR_*, TERM>
// Then it reads lines from the PTY:
//   say <text>    prints "said:<text>"
//   big <n>       prints <n> lines "line <i>"
//   exit <code>   exits with <code>
//   stubborn      ignores SIGHUP from now on
// On a resize it prints "resized <cols>x<rows>".
import { createInterface } from "node:readline";

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PI_SPORE_|ORCA_|HERDR_|TERM$)/.test(key)),
);
process.stdout.write(
  `READY cwd=${process.cwd()} size=${process.stdout.columns}x${process.stdout.rows} env=${JSON.stringify(env)}\r\n`,
);
process.stdout.on("resize", () => {
  process.stdout.write(`resized ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});

for await (const line of createInterface({ input: process.stdin })) {
  const [command, ...rest] = line.trim().split(" ");
  const arg = rest.join(" ");
  if (command === "say") process.stdout.write(`said:${arg}\r\n`);
  else if (command === "big") {
    for (let i = 0; i < Number(arg); i++) process.stdout.write(`line ${i}\r\n`);
  } else if (command === "exit") process.exit(Number(arg));
  else if (command === "stubborn") {
    process.on("SIGHUP", () => {});
    process.stdout.write("stubborn now\r\n");
  }
}
