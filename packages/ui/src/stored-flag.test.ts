import { describe, expect, it } from "vitest";
import { readFlag } from "./stored-flag.js";

describe("readFlag", () => {
  const storage = (value: string | null) => ({ getItem: () => value });

  it("reads 1 and 0", () => {
    expect(readFlag(storage("1"), "k", false)).toBe(true);
    expect(readFlag(storage("0"), "k", true)).toBe(false);
  });

  it("gives the fallback for nothing or another value", () => {
    expect(readFlag(storage(null), "k", true)).toBe(true);
    expect(readFlag(storage("yes"), "k", false)).toBe(false);
  });
});
