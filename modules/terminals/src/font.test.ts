import { describe, expect, it, vi } from "vitest";
import { FONT_STORAGE_KEY, fontStack, parseFontName, readFont } from "./font.js";

const storage = (value: string | null) => ({
  getItem: (key: string) => (key === FONT_STORAGE_KEY ? value : null),
});

describe("terminal font", () => {
  it("accepts font names and trims them", () => {
    expect(parseFontName("  FiraCode   Nerd Font Mono ")).toBe("FiraCode Nerd Font Mono");
    expect(parseFontName("Source_Code-Pro 2.0")).toBe("Source_Code-Pro 2.0");
    expect(parseFontName("   ")).toBeUndefined();
  });

  it("refuses names that could break out of the font list", () => {
    for (const bad of ['Evil", serif', "A;B", "a'b", "x".repeat(101)]) {
      expect(() => parseFontName(bad)).toThrow("letters, digits, spaces");
    }
  });

  it("puts the user's font first and the Nerd Fonts symbols after the app's font", () => {
    expect(fontStack(undefined)).toBe(
      '"JetBrains Mono Variable", "Symbols Nerd Font Mono", ui-monospace, monospace',
    );
    expect(fontStack("FiraCode Nerd Font Mono")).toBe(
      '"FiraCode Nerd Font Mono", "JetBrains Mono Variable", "Symbols Nerd Font Mono", ui-monospace, monospace',
    );
  });

  it("reads the stored font and ignores a bad stored value", () => {
    expect(readFont(storage(null))).toBeUndefined();
    expect(readFont(storage("Hack"))).toBe("Hack");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readFont(storage('Hack", serif'))).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
