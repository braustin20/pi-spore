// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast, Toaster } from "./toast.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root?.render(<Toaster />));
});

afterEach(() => {
  // The toast list is module state, so close what a test left open through the UI.
  act(() => {
    for (const close of closeButtons()) close.click();
  });
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const closeButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>("button[aria-label=Close]"),
];
const push = (title: string, href = "#/a") =>
  act(() => showToast({ title, body: "", tone: "ok", href }));

describe("Toaster", () => {
  it("shows the title, the body, and an Open link to href", () => {
    act(() =>
      showToast({ title: "Review ready", body: "Work a needs you", tone: "warn", href: "#/w/a" }),
    );
    expect(document.body.textContent).toContain("Review ready");
    expect(document.body.textContent).toContain("Work a needs you");
    const link = document.querySelector<HTMLAnchorElement>("a[href='#/w/a']");
    expect(link?.textContent).toBe("Open");
  });

  it("closes by itself after 8 seconds, not before", () => {
    push("Soon gone");
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(document.body.textContent).toContain("Soon gone");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.textContent).not.toContain("Soon gone");
  });

  it("shows only the last 3 of 4 toasts", () => {
    for (const title of ["one", "two", "three", "four"]) push(title);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("one");
    for (const title of ["two", "three", "four"]) expect(text).toContain(title);
  });

  it("removes a toast when its Close button is clicked", () => {
    push("Close me");
    expect(document.body.textContent).toContain("Close me");
    act(() => closeButtons()[0]?.click());
    expect(document.body.textContent).not.toContain("Close me");
  });
});
