// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followVisualViewport } from "./viewport-inset.js";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  width = 400;
  scale = 1;
}

let viewport: FakeViewport;
let unfollow: (() => void) | undefined;
const appended: HTMLElement[] = [];

function append<T extends HTMLElement>(el: T): T {
  document.body.append(el);
  appended.push(el);
  return el;
}

/** Stubs the frame API; returns the stored callbacks and the cancel spy. */
function stubFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return { frames, cancel };
}

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

function makeRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = "root";
  return append(root);
}

/** Records changes to the element's inline style; the result says whether it was ever `display: none`. */
function watchDisplay(el: HTMLElement): () => boolean {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return records.some((r) => r.oldValue?.includes("display: none"));
  };
}

function runFrames(frames: FrameRequestCallback[]) {
  for (const cb of frames.splice(0)) cb(0);
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
  document.documentElement.removeAttribute("data-keyboard-open");
  for (const el of appended.splice(0)) el.remove();
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

  it("on visibilitychange (hidden) blurs a focused text field", () => {
    follow();
    const textarea = append(document.createElement("textarea"));
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.activeElement).not.toBe(textarea);
  });

  it("on visibilitychange (hidden) leaves a focused checkbox alone", () => {
    follow();
    const box = append(document.createElement("input"));
    box.type = "checkbox";
    box.focus();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.activeElement).toBe(box);
  });

  it("marks <html> with data-keyboard-open while the keyboard is open", () => {
    const html = document.documentElement;
    viewport.height = 400;
    follow();
    expect(html.hasAttribute("data-keyboard-open")).toBe(true);
    viewport.height = 800;
    viewport.dispatchEvent(new Event("resize"));
    expect(html.hasAttribute("data-keyboard-open")).toBe(false);
    viewport.height = 400;
    viewport.dispatchEvent(new Event("resize"));
    unfollow?.();
    unfollow = undefined;
    expect(html.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("on resume updates again on the next frame", () => {
    const { frames } = stubFrames();
    follow();
    viewport.height = 600;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(prop("--app-height")).toBe("600px");
    viewport.height = 500;
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(prop("--app-height")).toBe("500px");
  });

  it("on pageshow updates again on the next frame", () => {
    const { frames } = stubFrames();
    follow();
    window.dispatchEvent(new Event("pageshow"));
    viewport.height = 500;
    frames[0]?.(0);
    expect(prop("--app-height")).toBe("500px");
  });

  it("cancels a pending frame before a new one and in the cleanup", () => {
    const { frames, cancel } = stubFrames();
    follow();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    expect(cancel).toHaveBeenCalledWith(1);
    unfollow?.();
    unfollow = undefined;
    expect(cancel).toHaveBeenLastCalledWith(frames.length);
  });

  describe("heal (ADR 0192)", () => {
    beforeEach(() => {
      setClientHeight(812);
      viewport.height = 812;
      viewport.width = 402;
    });

    it("flips #root display when the viewport comes back short on resume", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      const list = document.createElement("div");
      root.append(list);
      list.scrollTop = 300;
      // WebKit drops the scroll position of a box under display: none.
      Object.defineProperty(root, "offsetHeight", {
        configurable: true,
        get: () => {
          list.scrollTop = 0;
          return 0;
        },
      });
      follow();
      const flipped = watchDisplay(root);
      viewport.height = 761;
      document.dispatchEvent(new Event("visibilitychange"));
      runFrames(frames);
      expect(flipped()).toBe(true);
      expect(root.style.display).toBe("");
      expect(list.scrollTop).toBe(300);
    });

    it("flips #root display on a short resize with no focused field", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      const flipped = watchDisplay(root);
      viewport.height = 761;
      viewport.dispatchEvent(new Event("resize"));
      runFrames(frames);
      expect(flipped()).toBe(true);
      expect(root.style.display).toBe("");
    });

    it("updates the height after the flip", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      viewport.height = 761;
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(root, "offsetHeight", {
        configurable: true,
        get: () => {
          viewport.height = 812;
          return 0;
        },
      });
      runFrames(frames);
      expect(prop("--app-height")).toBe("812px");
    });

    it("does not flip while a text field has focus (the keyboard is open)", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      const textarea = append(document.createElement("textarea"));
      textarea.focus();
      const flipped = watchDisplay(root);
      viewport.height = 390;
      viewport.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("visibilitychange"));
      runFrames(frames);
      expect(flipped()).toBe(false);
    });

    it("does not flip when the height equals the full height", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      const flipped = watchDisplay(root);
      viewport.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("visibilitychange"));
      runFrames(frames);
      expect(flipped()).toBe(false);
    });

    it("does not count a height seen with a focused field as full", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      viewport.height = 761;
      follow();
      const textarea = append(document.createElement("textarea"));
      textarea.focus();
      viewport.height = 812;
      viewport.dispatchEvent(new Event("resize"));
      textarea.blur();
      const flipped = watchDisplay(root);
      viewport.height = 761;
      viewport.dispatchEvent(new Event("resize"));
      runFrames(frames);
      expect(flipped()).toBe(false);
    });

    it("resets the full height when the width changes, so a rotation does not flip", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      const flipped = watchDisplay(root);
      viewport.width = 874;
      viewport.height = 370;
      viewport.dispatchEvent(new Event("resize"));
      runFrames(frames);
      expect(flipped()).toBe(false);
    });

    it("does not flip while the page is pinch-zoomed", () => {
      const { frames } = stubFrames();
      const root = makeRoot();
      follow();
      const flipped = watchDisplay(root);
      viewport.scale = 2;
      viewport.height = 406;
      viewport.dispatchEvent(new Event("resize"));
      runFrames(frames);
      expect(flipped()).toBe(false);
    });

    it("the cleanup cancels a pending heal", () => {
      const { frames, cancel } = stubFrames();
      makeRoot();
      follow();
      viewport.height = 761;
      document.dispatchEvent(new Event("visibilitychange"));
      // Run the resume frame but keep it stored, so the heal frame gets a different id.
      frames[0]?.(0);
      viewport.height = 760;
      viewport.dispatchEvent(new Event("resize"));
      const healFrame = vi.mocked(window.requestAnimationFrame).mock.results.at(-1)?.value;
      expect(healFrame).toBe(2);
      cancel.mockClear();
      unfollow?.();
      unfollow = undefined;
      expect(cancel).toHaveBeenCalledWith(healFrame);
    });
  });
});
