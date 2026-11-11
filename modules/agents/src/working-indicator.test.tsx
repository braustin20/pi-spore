// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkingIndicator } from "./working-indicator.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("WorkingIndicator", () => {
  it("shows the animated spore logo with the label", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root?.render(<WorkingIndicator label="Thinking" />));
    const status = container.querySelector("[role=status]");
    expect(status?.textContent).toContain("Thinking");
    expect(status?.querySelector("svg.spore-logo-working")).not.toBeNull();
  });
});
