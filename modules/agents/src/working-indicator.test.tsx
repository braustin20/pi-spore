// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingIndicator } from "./working-indicator.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(() => vi.useRealTimers());

const render = (since: number, label = "Running bash: npm test") =>
  act(() => root?.render(<WorkingIndicator label={label} since={since} />));
const count = () => container?.querySelector("[role=status] .font-mono")?.textContent;

describe("WorkingIndicator", () => {
  it("shows the animated spore logo with the label", () => {
    render(NOW, "Thinking");
    const status = container?.querySelector("[role=status]");
    expect(status?.textContent).toContain("Thinking");
    expect(status?.querySelector("svg.spore-logo-working")).not.toBeNull();
  });

  it("counts from the time the agent started, in minutes past a minute", () => {
    render(NOW - 90_000);
    expect(count()).toBe("1m 30s");
    act(() => vi.advanceTimersByTime(1_000));
    expect(count()).toBe("1m 31s");
  });

  it("shows seconds under a minute", () => {
    render(NOW - 42_000);
    expect(count()).toBe("42s");
  });

  it("keeps the count when the page mounts it again", () => {
    render(NOW - 5_000);
    act(() => vi.advanceTimersByTime(3_000));
    act(() => root?.unmount());
    root = createRoot(container as HTMLElement);
    render(NOW - 5_000);
    expect(count()).toBe("8s");
  });

  it("never shows a negative count when the server clock is ahead", () => {
    render(NOW + 4_000);
    expect(count()).toBe("0s");
  });
});
