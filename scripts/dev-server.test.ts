import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devEnv, ensureSampleRepo, freePort } from "./dev-server-lib.mjs";

const execFileAsync = promisify(execFile);

describe("devEnv", () => {
  it("points at the dev home, drops the outer server's names, and keeps the input", () => {
    const input = {
      PATH: "/usr/bin",
      PI_SPORE_HOME: "/home/user/.pi-spore",
      PI_SPORE_URL: "http://127.0.0.1:7420/",
      PI_SPORE_TOKEN: "secret",
      PI_SPORE_SERVER_PID: "42",
      PI_SPORE_WORKSPACE_ID: "ws-1",
    };
    const copy = { ...input };
    const result = devEnv(input, "/work/.pi-spore-dev/home", 51234);
    expect(result.PI_SPORE_HOME).toBe("/work/.pi-spore-dev/home");
    expect(result.PI_SPORE_PORT).toBe("51234");
    expect(result.PATH).toBe("/usr/bin");
    for (const name of [
      "PI_SPORE_URL",
      "PI_SPORE_TOKEN",
      "PI_SPORE_SERVER_PID",
      "PI_SPORE_WORKSPACE_ID",
    ]) {
      expect(result).not.toHaveProperty(name);
    }
    expect(input).toEqual(copy);
  });
});

describe("freePort", () => {
  it("returns a usable port that is not the real server's", async () => {
    const port = await freePort();
    expect(port).not.toBe(7420);
    expect(port).toBeGreaterThanOrEqual(1);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe("ensureSampleRepo", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-spore-sample-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const commitCount = async (dir: string) =>
    Number(
      (await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: dir })).stdout.trim(),
    );

  it("creates one commit once and leaves an existing folder alone", async () => {
    const dir = join(root, "sample-repo");
    expect(await ensureSampleRepo(dir)).toBe(true);
    expect(await commitCount(dir)).toBe(1);
    expect(await ensureSampleRepo(dir)).toBe(false);
    expect(await commitCount(dir)).toBe(1);
  });
});
