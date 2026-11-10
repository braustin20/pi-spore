// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

function render(text: string): HTMLElement {
  container = document.body.appendChild(document.createElement("div"));
  act(() => {
    createRoot(container as HTMLElement).render(<Markdown text={text} />);
  });
  return container;
}

describe("Markdown", () => {
  it("renders bold text and GFM tables", () => {
    const root = render("**bold**\n\n| a | b |\n| - | - |\n| 1 | 2 |");

    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("table")).not.toBeNull();
  });

  it("renders no script or img element from raw HTML", () => {
    const root = render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");

    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });

  it("opens links in a new tab and drops javascript: URLs", () => {
    const root = render("[site](https://example.com) and [bad](javascript:alert(1))");

    const site = root.querySelector('a[href="https://example.com"]');
    expect(site?.getAttribute("target")).toBe("_blank");
    expect(site?.getAttribute("rel")).toBe("noreferrer");

    const bad = [...root.querySelectorAll("a")].find((link) => link.textContent === "bad");
    expect(bad).toBeDefined();
    expect(bad?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("shows a Markdown image as a link, so no remote image loads (ADR 0061)", () => {
    const root = render("![x](https://example.com/a.png)");

    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")?.textContent).toBe("x");
  });

  it("renders a fenced code block inside pre and code", () => {
    const root = render("```ts\nconst x = 1;\n```");

    expect(root.querySelector("pre > code")?.textContent).toContain("const x = 1;");
  });
});
