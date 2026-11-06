#!/usr/bin/env node
import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2), {
  fetch,
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
