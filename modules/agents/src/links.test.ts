import { describe, expect, it } from "vitest";
import { isImagePath, linkTarget } from "./links.js";

describe("linkTarget", () => {
  it("sorts remote addresses, local paths, and the rest", () => {
    expect(linkTarget("https://example.com/a.png")).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
      host: "example.com",
    });
    expect(linkTarget("HTTP://example.com:8080/x")).toMatchObject({
      kind: "remote",
      host: "example.com:8080",
    });
    expect(linkTarget("/tmp/work/out/shot.png")).toEqual({
      kind: "local",
      path: "/tmp/work/out/shot.png",
    });
    expect(linkTarget("out/my%20shot.png")).toEqual({ kind: "local", path: "out/my shot.png" });
    expect(linkTarget("./a.png")).toEqual({ kind: "local", path: "./a.png" });
    expect(linkTarget("file:///tmp/a%20b.png")).toEqual({ kind: "local", path: "/tmp/a b.png" });
    expect(linkTarget("100%.png")).toEqual({ kind: "local", path: "100%.png" });
    for (const url of [
      "",
      "#top",
      "?q=1",
      "//example.com/a.png",
      "mailto:a@b.c",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file://server/share/a.png",
    ])
      expect(linkTarget(url), url).toEqual({ kind: "other" });
  });

  it("knows image paths by extension", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif"].every(isImagePath)).toBe(true);
    expect(["a.svg", "b.png.txt", "notes.md", "png"].some(isImagePath)).toBe(false);
  });
});
