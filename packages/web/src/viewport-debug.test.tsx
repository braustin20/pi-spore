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

  it("stays on after a reload", () => {
    localStorage.setItem("pi-spore.viewport-debug", "on");
    render();
    act(() => root?.unmount());
    container?.remove();
    render();
    expect(document.body.querySelector("[data-viewport-debug]")).not.toBeNull();
  });
});
