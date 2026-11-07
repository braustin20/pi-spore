import { describe, expect, it } from "vitest";
import { terminalTheme } from "./theme.js";

/** Each token reads as its own name, so the test sees which token fills which color. */
const read = (token: string) => token;

describe("terminalTheme", () => {
  it("takes every color from a role token", () => {
    const theme = terminalTheme(read, false);
    for (const value of Object.values(theme)) expect(value).toMatch(/^--[a-z-]+$/);
    expect(theme).toMatchObject({
      background: "--panel",
      foreground: "--text",
      red: "--fail",
      green: "--ok",
      yellow: "--warn",
      black: "--raised",
      white: "--text",
    });
  });

  it("keeps black and white text readable in a light theme", () => {
    const theme = terminalTheme(read, true);
    expect(theme.black).toBe("--text");
    expect(theme.white).toBe("--text-muted");
    expect(theme.brightWhite).toBe("--text-muted");
  });
});
