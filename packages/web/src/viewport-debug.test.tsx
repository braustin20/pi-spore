// @vitest-environment happy-dom
import { setViewportDebug } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ViewportDebug } from "./viewport-debug.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

function render(): HTMLElement {
  const div = document.body.appendChild(document.createElement("div"));
  container = div;
  root = createRoot(div);
  act(() => root?.render(<ViewportDebug />));
  return div;
}

describe("the viewport numbers overlay", () => {
  it("is off by default", () => {
    render();
    expect(document.body.querySelector("[data-viewport-debug]")).toBeNull();
  });

  it("shows on document.body when turned on and hides when turned off", () => {
    const div = render();
    act(() => setViewportDebug(true));
    const overlay = document.body.querySelector("[data-viewport-debug]");
    expect(overlay?.parentElement).toBe(document.body);
    expect(div.contains(overlay)).toBe(false);
    act(() => setViewportDebug(false));
    expect(document.body.querySelector("[data-viewport-debug]")).toBeNull();
  });

  it("keeps every line short enough for 60vw of a 390px phone", () => {
    const saved = (name: "visualViewport" | "scrollY") =>
      [name, Object.getOwnPropertyDescriptor(window, name)] as const;
    const descriptors = [saved("visualViewport"), saved("scrollY")];
    const viewport = { height: 663.333, offsetTop: 312.75, pageTop: 1234.56, scale: 1.25 };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: Object.assign(new EventTarget(), viewport),
    });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1234.56 });
    try {
      render();
      act(() => setViewportDebug(true));
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const text = document.body.querySelector("[data-viewport-debug]")?.textContent ?? "";
      expect(text).toContain("visibilitychange:visible");
      // 9px monospace is about 5.4px a character; 60vw of 390px less the padding holds about 41.
      expect(text.split("\n").filter((line) => line.length > 40)).toEqual([]);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(window, name, descriptor);
        else delete (window as Partial<Window>)[name];
      }
    }
  });

  it("stays on after a reload", () => {
    localStorage.setItem("pi-spore.viewport-debug", "on");
    render();
    act(() => root?.unmount());
    container?.remove();
    render();
    expect(document.body.querySelector("[data-viewport-debug]")).not.toBeNull();
  });
});
