import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLocks, lockDir } from "./lock.js";

let dir: string;
const TARGET = "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs";
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "pi-spore-lock-")), "pi-spore");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("LocalLocks", () => {
  it("gives one slot per concurrency to live processes and frees it on release", async () => {
    const alive = new Set([100, 200]);
    const first = new LocalLocks(dir, 100, (pid) => alive.has(pid));
    const second = new LocalLocks(dir, 200, (pid) => alive.has(pid));

    const path = await first.tryAcquire(TARGET, 1, "s1");
    expect(path).toBe(join(dir, "strata_qwen3.8-flash-next-unsloth-ud-iq2_xs.0.lock"));
    expect(JSON.parse(readFileSync(path as string, "utf8"))).toMatchObject({
      pid: 100,
      session: "s1",
    });
    expect(await first.tryAcquire(TARGET, 1, "s1")).toBe(path);
    expect(await second.tryAcquire(TARGET, 1, "s2")).toBeUndefined();
    expect(await second.tryAcquire(TARGET, 2, "s2")).toMatch(/\.1\.lock$/);

    await second.release(path as string);
    expect(await second.tryAcquire(TARGET, 1, "s2")).toBeUndefined();
    await first.release(path as string);
    expect(await second.tryAcquire(TARGET, 1, "s2")).toBe(path);
  });

  it("takes over a lock whose process is gone, or whose file is junk", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "strata_qwen3.8-flash-next-unsloth-ud-iq2_xs.0.lock");
    writeFileSync(path, JSON.stringify({ pid: 999 }));
    const locks = new LocalLocks(dir, 100, (pid) => pid === 100);
    expect(await locks.tryAcquire(TARGET, 1, "s")).toBe(path);
    rmSync(path);
    writeFileSync(path, "{");
    expect(await locks.tryAcquire(TARGET, 1, "s")).toBe(path);
  });
});

describe("lockDir", () => {
  it("lives under XDG_RUNTIME_DIR and has no fallback", () => {
    expect(lockDir({ XDG_RUNTIME_DIR: "/run/user/7" })).toBe("/run/user/7/pi-spore");
    expect(() => lockDir({})).toThrow("XDG_RUNTIME_DIR is not set");
  });
});
