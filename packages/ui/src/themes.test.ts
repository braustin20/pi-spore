import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, readTheme, THEME_STORAGE_KEY, THEMES } from "./themes.js";

const TOKENS = [
  "bg",
  "panel",
  "raised",
  "line",
  "text",
  "text-muted",
  "accent",
  "accent-strong",
  "on-accent",
  "ok",
  "fail",
  "warn",
  "run",
  "diff-add",
  "diff-del",
] as const;
type Token = (typeof TOKENS)[number];
type Rgb = [number, number, number];

/** The token values of each `[data-theme="<id>"]` block in themes.css. */
function themeBlocks(): Map<string, Map<string, string>> {
  const css = readFileSync(new URL("./themes.css", import.meta.url), "utf8");
  const blocks = new Map<string, Map<string, string>>();
  for (const match of css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    const values = new Map<string, string>();
    for (const decl of (match[2] as string).matchAll(/--([\w-]+):\s*([^;]+);/g))
      values.set(decl[1] as string, (decl[2] as string).trim());
    blocks.set(match[1] as string, values);
  }
  return blocks;
}

function parseHsl(value: string): Rgb {
  const match = /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/.exec(value);
  if (!match) throw new Error(`Not an hsl(h s% l%) color: ${value}`);
  const h = Number(match[1]);
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG 2 relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text tokens and the surfaces they are drawn on. AA for normal text is 4.5:1. */
const TEXT_ON: [Token[], Token[]][] = [
  [
    ["text", "text-muted", "accent-strong", "ok", "fail", "warn", "run", "diff-add", "diff-del"],
    ["bg", "panel", "raised"],
  ],
  [["on-accent"], ["accent"]],
];

describe("built-in themes", () => {
  const blocks = themeBlocks();

  it("has one css block per theme in the menu, and no others", () => {
    expect([...blocks.keys()].sort()).toEqual(THEMES.map((theme) => theme.id).sort());
    expect(THEMES.map((theme) => theme.id)).toContain(DEFAULT_THEME);
  });

  for (const theme of THEMES) {
    it(`${theme.name} sets every role token`, () => {
      const values = blocks.get(theme.id);
      expect([...(values?.keys() ?? [])].sort()).toEqual([...TOKENS].sort());
    });

    it(`${theme.name} meets WCAG AA for text on bg, panel, raised, and accent`, () => {
      const values = blocks.get(theme.id) as Map<string, string>;
      const color = (token: Token) => parseHsl(values.get(token) ?? "missing");
      const failures: string[] = [];
      for (const [texts, surfaces] of TEXT_ON) {
        for (const text of texts) {
          for (const surface of surfaces) {
            const ratio = contrast(color(text), color(surface));
            if (ratio < 4.5) failures.push(`--${text} on --${surface}: ${ratio.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("readTheme", () => {
  const storage = (value: string | null) => ({
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  });

  it("returns the stored theme", () => {
    expect(readTheme(storage("ayu-dark"))).toBe("ayu-dark");
  });

  it("returns the default when nothing or an unknown theme is stored", () => {
    expect(readTheme(storage(null))).toBe(DEFAULT_THEME);
    expect(readTheme(storage("gone"))).toBe(DEFAULT_THEME);
  });
});
