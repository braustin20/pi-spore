import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("LocalLocks queue", () => {
  const alive = new Set([100, 200, 300, 400]);
  const locks = (pid: number) => new LocalLocks(dir, pid, (other) => alive.has(other));

  it("is empty and idle when nothing exists", async () => {
    expect(await locks(100).queue(TARGET, 1)).toEqual({ busy: false, waiting: 0 });
  });

  it("is busy only when every slot is held by another live process", async () => {
    await locks(200).tryAcquire(TARGET, 2, "s2");
    expect(await locks(100).queue(TARGET, 2)).toEqual({ busy: false, waiting: 0 });
    await locks(300).tryAcquire(TARGET, 2, "s3");
    expect(await locks(100).queue(TARGET, 2)).toEqual({ busy: true, waiting: 0 });
    // A slot this process holds does not make the target busy for it.
    expect(await locks(200).queue(TARGET, 2)).toEqual({ busy: false, waiting: 0 });
  });

  it("counts wait files of other live processes, and removes those of dead ones", async () => {
    const mine = await locks(100).joinQueue(TARGET, "s1");
    const other = await locks(200).joinQueue(TARGET, "s2");
    const dead = join(dir, "strata_qwen3.8-flash-next-unsloth-ud-iq2_xs.wait.999.lock");
    writeFileSync(dead, JSON.stringify({ pid: 999 }));

    expect(mine).toBe(join(dir, "strata_qwen3.8-flash-next-unsloth-ud-iq2_xs.wait.100.lock"));
    expect(JSON.parse(readFileSync(mine, "utf8"))).toMatchObject({ pid: 100, session: "s1" });
    expect(await locks(100).queue(TARGET, 1)).toEqual({ busy: false, waiting: 1 });
    expect(existsSync(dead)).toBe(false);

    await locks(200).leaveQueue(other);
    expect(await locks(100).queue(TARGET, 1)).toEqual({ busy: false, waiting: 0 });
    expect(existsSync(mine)).toBe(true);
  });

  it("does not count the wait files of another target", async () => {
    await locks(200).joinQueue("other/model", "s2");
    expect(await locks(100).queue(TARGET, 1)).toEqual({ busy: false, waiting: 0 });
  });
});

describe("lockDir", () => {
  it("lives under XDG_RUNTIME_DIR and has no fallback", () => {
    expect(lockDir({ XDG_RUNTIME_DIR: "/run/user/7" })).toBe("/run/user/7/pi-spore");
    expect(() => lockDir({})).toThrow("XDG_RUNTIME_DIR is not set");
  });
});
