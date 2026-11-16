// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followVisualViewport } from "./viewport-inset.js";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

let viewport: FakeViewport;
let unfollow: (() => void) | undefined;

function setClientHeight(px: number) {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: px,
    configurable: true,
  });
}

function setScroll(x: number, y: number) {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true, writable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function prop(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

function follow() {
  unfollow = followVisualViewport(window);
}

beforeEach(() => {
  viewport = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  setClientHeight(800);
  setScroll(0, 0);
  setVisibility("visible");
});

afterEach(() => {
  unfollow?.();
  unfollow = undefined;
  vi.restoreAllMocks();
  Object.defineProperty(window, "visualViewport", { value: null, configurable: true });
  delete (document as unknown as Record<string, unknown>).visibilityState;
  setScroll(0, 0);
  document.documentElement.style.cssText = "";
});

describe("followVisualViewport", () => {
  it("sets the height and keeps the top at 0 when no keyboard is open", () => {
    viewport.height = 800;
    viewport.offsetTop = 40;
    follow();
    expect(prop("--app-height")).toBe("800px");
    expect(prop("--app-top")).toBe("0px");
  });

  it("follows the offset while the keyboard is open", () => {
    viewport.height = 400;
    viewport.offsetTop = 120;
    follow();
    expect(prop("--app-height")).toBe("400px");
    expect(prop("--app-top")).toBe("120px");
  });

  it("counts a gap of exactly 100px as no keyboard, and 101px as a keyboard", () => {
    viewport.height = 700;
    viewport.offsetTop = 50;
    follow();
    expect(prop("--app-top")).toBe("0px");
    unfollow?.();
    viewport.height = 699;
    follow();
    expect(prop("--app-top")).toBe("50px");
  });

  it("re-runs update when the viewport resizes", () => {
    follow();
    viewport.height = 400;
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event("resize"));
    expect(prop("--app-height")).toBe("400px");
    expect(prop("--app-top")).toBe("120px");
  });

  it("re-runs update when the viewport scrolls", () => {
    follow();
    viewport.height = 400;
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event("scroll"));
    expect(prop("--app-top")).toBe("120px");
  });

  it("on visibilitychange (visible) updates and resets a scrolled page", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    setScroll(0, 30);
    follow();
    viewport.height = 400;
    viewport.offsetTop = 120;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(prop("--app-top")).toBe("120px");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("on visibilitychange resets a page scrolled sideways", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    setScroll(20, 0);
    follow();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("on visibilitychange does not scroll a page that is at the top", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    follow();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("ignores visibilitychange while the page is hidden", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    setVisibility("hidden");
    setScroll(0, 30);
    follow();
    viewport.height = 400;
    viewport.offsetTop = 120;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(prop("--app-height")).toBe("800px");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("on pageshow updates and resets a scrolled page", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    setScroll(0, 30);
    follow();
    viewport.height = 400;
    viewport.offsetTop = 120;
    window.dispatchEvent(new Event("pageshow"));
    expect(prop("--app-top")).toBe("120px");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("the cleanup removes both props, and later events change nothing", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    viewport.height = 400;
    viewport.offsetTop = 120;
    follow();
    expect(prop("--app-top")).toBe("120px");
    unfollow?.();
    unfollow = undefined;
    expect(prop("--app-height")).toBe("");
    expect(prop("--app-top")).toBe("");
    setScroll(0, 30);
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    expect(prop("--app-height")).toBe("");
    expect(prop("--app-top")).toBe("");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing when the window has no visual viewport", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "visualViewport", { value: null, configurable: true });
    setScroll(0, 30);
    follow();
    window.dispatchEvent(new Event("pageshow"));
    expect(prop("--app-height")).toBe("");
    expect(prop("--app-top")).toBe("");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
