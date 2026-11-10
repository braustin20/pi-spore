// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initTheme, setTheme } from "./themes.js";

describe("the favicon", () => {
  it("draws the logo in the accent of the theme on the page", () => {
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = readFileSync(`${import.meta.dirname}/themes.css`, "utf8");
    const link = document.head.appendChild(document.createElement("link"));
    link.rel = "icon";
    link.href = "/icon.svg";

    initTheme();
    setTheme("dracula");
    const dracula = link.getAttribute("href") ?? "";
    expect(dracula.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(dracula)).toContain("hsl(265 89% 78%)");
    expect(decodeURIComponent(dracula)).toContain("<circle");

    setTheme("nord");
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain("hsl(193 43% 67%)");
  });
});
