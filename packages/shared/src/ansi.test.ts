import { describe, expect, it } from "vitest";
import { logTail, stripAnsi } from "./ansi.js";

const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  it("removes colors and an OSC link, and leaves no ESC", () => {
    const text = `${ESC}[31mred${ESC}[39m ${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}]0;title\u0007ok${ESC}c`;

    const clean = stripAnsi(text);

    expect(clean).toBe("red link ok");
    expect(clean).not.toContain(ESC);
  });

  it("removes a stray ESC", () => {
    expect(stripAnsi(`a${ESC}`)).toBe("a");
  });

  it("keeps the text after an OSC code that has no end", () => {
    expect(stripAnsi(`${ESC}]8;;x\nnext line`)).toBe("8;;x\nnext line");
  });
});

describe("logTail", () => {
  it("returns a short text whole, without codes and trailing space", () => {
    expect(logTail(`${ESC}[1mone${ESC}[22m\ntwo\n\n`, 100)).toBe("one\ntwo");
  });

  it("starts at a whole line and leaves no half code when it cuts", () => {
    const line = (n: number) => `${ESC}[31m${ESC}[1mline ${n}${ESC}[22m${ESC}[39m`;
    const text = Array.from({ length: 50 }, (_, n) => line(n)).join("\n");

    for (let chars = 20; chars < 120; chars++) {
      const tail = logTail(text, chars);
      expect(tail).not.toContain(ESC);
      expect(tail).not.toMatch(/\[\d+m/);
      expect(tail.length).toBeLessThanOrEqual(chars);
      expect(tail).toMatch(/^line \d+$|^line \d+\n/);
    }
    expect(logTail(text, 40).endsWith("line 49")).toBe(true);
  });

  it("keeps the end of a cut line that is the only one left", () => {
    expect(logTail("prefix\nabcdef", 3)).toBe("def");
  });

  it("keeps a first line that the cut leaves whole", () => {
    expect(logTail("one\ntwo\nthree", 9)).toBe("two\nthree");
    expect(logTail("one\ntwo\nthree", 5)).toBe("three");
  });
});
