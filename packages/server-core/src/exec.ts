import { execFile } from "node:child_process";
import type { Exec } from "@pi-spore/module-api";

const DEFAULT_TIMEOUT_MS = 120_000;

export const exec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        if (error.killed) {
          return reject(
            new Error(`${command} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`),
          );
        }
        // A numeric code is the program's exit status; a string code (ENOENT, EACCES) means it did not start.
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
        reject(new Error(`Cannot run ${command}: ${error.message}`, { cause: error }));
      },
    );
  });
