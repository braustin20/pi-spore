import { afterEach, describe, expect, it, vi } from "vitest";
import { clampWidth, readWidth, stepWidth, writeWidth } from "./panel-width.js";

afterEach(() => vi.restoreAllMocks());

describe("clampWidth", () => {
  it("keeps a width inside the limits", () => {
    expect(clampWidth(300, 200, 480)).toBe(300);
    expect(clampWidth(100, 200, 480)).toBe(200);
    expect(clampWidth(900, 200, 480)).toBe(480);
  });

  it("rounds to whole pixels", () => {
    expect(clampWidth(300.6, 200, 480)).toBe(301);
  });

  it("gives the minimum when the maximum is below it", () => {
    expect(clampWidth(300, 280, 140)).toBe(280);
  });
});

describe("stepWidth", () => {
  it("moves the edge 16 px per arrow key, 64 px with Shift", () => {
    expect(stepWidth(300, "ArrowRight", false, 1)).toBe(316);
    expect(stepWidth(300, "ArrowLeft", false, 1)).toBe(284);
    expect(stepWidth(300, "ArrowRight", true, 1)).toBe(364);
    expect(stepWidth(300, "ArrowLeft", true, 1)).toBe(236);
  });

  it("grows a right-side panel when its edge moves left", () => {
    expect(stepWidth(300, "ArrowLeft", false, -1)).toBe(316);
    expect(stepWidth(300, "ArrowRight", true, -1)).toBe(236);
  });

  it("ignores other keys", () => {
    expect(stepWidth(300, "ArrowUp", false, 1)).toBeUndefined();
    expect(stepWidth(300, "a", false, 1)).toBeUndefined();
  });
});

describe("readWidth and writeWidth", () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };

  it("reads back a written width", () => {
    const storage = memory();
    writeWidth(storage, "k", 312);
    expect(storage.getItem("k")).toBe("312");
    expect(readWidth(storage, "k", 256)).toBe(312);
  });

  it("gives the fallback for nothing stored or a bad value", () => {
    const stored = (value: string | null) => ({ getItem: () => value });
    expect(readWidth(stored(null), "k", 256)).toBe(256);
    for (const bad of ["", "wide", "12.5", "-40", "0", "1e3", " 300", "NaN", "Infinity"]) {
      expect(readWidth(stored(bad), "k", 256)).toBe(256);
    }
  });

  it("gives the fallback and logs once when the storage is blocked", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const blocked = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {
        throw new Error("SecurityError");
      },
    };
    expect(readWidth(blocked, "k", 256)).toBe(256);
    expect(readWidth(blocked, "k", 256)).toBe(256);
    expect(() => writeWidth(blocked, "k", 300)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
