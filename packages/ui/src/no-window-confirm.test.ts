import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("confirmations", () => {
  it("never call window.confirm; they use useConfirm from @pi-spore/ui (ADR 0029)", () => {
    const offenders = ["packages", "modules"]
      .flatMap((top) => readdirSync(join(root, top)).map((name) => join(root, top, name, "src")))
      .flatMap((src) => {
        try {
          return sources(src);
        } catch {
          return [];
        }
      })
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("window.confirm"))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
