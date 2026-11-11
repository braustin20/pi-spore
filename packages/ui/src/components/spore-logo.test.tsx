// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SporeLogo } from "./spore-logo.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKING = "spore-logo-working";

function motion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reduced,
    addEventListener() {},
    removeEventListener() {},
  }));
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function svg(logo: ReactElement): SVGSVGElement {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root?.render(logo));
  const rendered = container.querySelector("svg");
  if (!rendered) throw new Error("the logo did not render");
  return rendered;
}

describe("SporeLogo", () => {
  it("animates while working", () => {
    motion(false);
    expect(svg(<SporeLogo working />).classList.contains(WORKING)).toBe(true);
  });

  it("stands still while working when the user asks for reduced motion", () => {
    motion(true);
    expect(svg(<SporeLogo working />).classList.contains(WORKING)).toBe(false);
  });

  it("stands still when not working", () => {
    motion(false);
    expect(svg(<SporeLogo />).classList.contains(WORKING)).toBe(false);
  });
});
