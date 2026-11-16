#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CliDeps, run } from "./cli.js";

/** The file's text; undefined when it does not exist. */
function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** `PI_SPORE_TOKEN`, else the token file the server writes on first start (the same folder rules as the server). */
function readToken(): string | undefined {
  if (process.env.PI_SPORE_TOKEN) return process.env.PI_SPORE_TOKEN;
  const home = process.env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore");
  return readIfExists(join(home, "token"))?.trim() || undefined;
}

const system: CliDeps["system"] = {
  run: (file, args, options) =>
    new Promise((done, fail) => {
      // Ctrl+C goes to the child too; the CLI waits for it to end instead of dying first.
      const ignore = () => {};
      process.on("SIGINT", ignore);
      const child = spawn(file, args, {
        stdio: "inherit",
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        process.off("SIGINT", ignore);
        fail(error.code === "ENOENT" ? new Error(`${file} not found`) : error);
      });
      child.on("close", (code) => {
        process.off("SIGINT", ignore);
        done(code ?? 1);
      });
    }),
  readFile: readIfExists,
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  removeFile: (path) => rmSync(path),
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  ask: async (question) => {
    if (!process.stdin.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
    } finally {
      prompt.close();
    }
  },
  node: { path: process.execPath, version: process.version },
  platform: process.platform,
  // main.js lives in <repo>/packages/cli/dist.
  repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  configHome: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  delay: (ms) => sleep(ms),
};

process.exitCode = await run(process.argv.slice(2), {
  fetch,
  env: process.env,
  out: (line) => console.log(line),
  write: (text) => process.stdout.write(text),
  err: (line) => console.error(line),
  readToken,
  resolvePath: (path) => resolve(process.cwd(), path),
  newKey: randomUUID,
  now: Date.now,
  system,
});
