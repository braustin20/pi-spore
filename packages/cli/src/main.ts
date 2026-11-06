#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./cli.js";

/** `PI_SPORE_TOKEN`, else the token file the server writes on first start (the same folder rules as the server). */
function readToken(): string | undefined {
  if (process.env.PI_SPORE_TOKEN) return process.env.PI_SPORE_TOKEN;
  const home = process.env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore");
  try {
    return readFileSync(join(home, "token"), "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

process.exitCode = await run(process.argv.slice(2), {
  fetch,
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readToken,
  resolvePath: (path) => resolve(process.cwd(), path),
  newKey: randomUUID,
});
