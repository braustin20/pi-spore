import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Fix the Crafting Recipe UI!")).toBe("fix-the-crafting-recipe-ui");
  });

  it("drops accents and trims dashes", () => {
    expect(slugify("  Café — déjà vu  ")).toBe("cafe-deja-vu");
  });

  it("cuts long names without a trailing dash", () => {
    expect(slugify("a".repeat(39) + " b c", 40)).toBe("a".repeat(39));
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("work");
  });
});
