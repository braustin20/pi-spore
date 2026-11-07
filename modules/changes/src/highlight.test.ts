import { describe, expect, it } from "vitest";
import { highlightLines, languageOf } from "./highlight.js";

const flat = (lines: ReturnType<typeof highlightLines>) =>
  lines.map((line) => line.map((token) => `${token.className || "-"}:${token.text}`).join(" "));

describe("highlightLines", () => {
  it("colors code with role-token classes, one token list per line", () => {
    const lines = highlightLines(['const a = "x";', "", "return 1;"], "typescript");
    expect(lines).toHaveLength(3);
    expect(flat(lines)).toEqual([
      'text-accent-strong:const -: a =  text-ok:"x" -:;',
      "",
      "text-accent-strong:return -:  text-warn:1 -:;",
    ]);
  });

  it("keeps a comment over several lines colored on each line", () => {
    const lines = highlightLines(["/* one", "two */ x"], "typescript");
    expect(flat(lines)).toEqual(["text-muted italic:/* one", "text-muted italic:two */ -: x"]);
  });

  it("leaves text plain without a language", () => {
    expect(flat(highlightLines(["a", "b"], undefined))).toEqual(["-:a", "-:b"]);
  });
});

describe("languageOf", () => {
  it("knows code, Unity assets, and plain files", () => {
    expect(languageOf("src/a.tsx")).toBe("typescript");
    expect(languageOf("Assets/Player.cs")).toBe("csharp");
    expect(languageOf("Assets/Main.unity")).toBe("yaml");
    expect(languageOf("Makefile")).toBe("makefile");
    expect(languageOf("notes.txt")).toBeUndefined();
    expect(languageOf(".gitignore")).toBeUndefined();
  });
});
