// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDocumentScroll } from "./scroll-lock.js";

let unlock: (() => void) | undefined;
beforeEach(() => {
  unlock = lockDocumentScroll(document);
});
afterEach(() => {
  unlock?.();
  document.body.replaceChildren();
});

function add<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  sizes: Partial<
    Record<"scrollHeight" | "clientHeight" | "scrollWidth" | "clientWidth", number>
  > = {},
): HTMLElementTagNameMap[K] {
  const el = parent.appendChild(document.createElement(tag));
  Object.assign(el.style, style);
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
  return el;
}

function touch(target: Element, x: number, y: number) {
  return { identifier: 0, target, clientX: x, clientY: y } as unknown as Touch;
}

/** Puts one finger down at (0, 0), then moves it to (dx, dy). Returns whether the move was cancelled. */
function drag(target: Element, dx: number, dy: number, fingers = 1): boolean {
  const start = touch(target, 0, 0);
  target.dispatchEvent(
    new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [start] }),
  );
  const touches = Array.from({ length: fingers }, () => touch(target, dx, dy));
  const move = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches });
  target.dispatchEvent(move);
  return move.defaultPrevented;
}

describe("lockDocumentScroll", () => {
  it("blocks a vertical move on a plain bar", () => {
    const bar = add(document.body, "div");
    expect(drag(bar, 0, -30)).toBe(true);
  });

  it("allows a vertical move inside a list that has room", () => {
    const list = add(
      document.body,
      "div",
      { overflowY: "auto" },
      { scrollHeight: 500, clientHeight: 100 },
    );
    list.scrollTop = 50;
    const row = add(list, "div");
    expect(drag(row, 0, -30)).toBe(false);
    expect(drag(row, 0, 30)).toBe(false);
  });

  it("blocks a pull-down at the top edge of a list", () => {
    const list = add(
      document.body,
      "div",
      { overflowY: "auto" },
      { scrollHeight: 500, clientHeight: 100 },
    );
    list.scrollTop = 0;
    const row = add(list, "div");
    expect(drag(row, 0, 30)).toBe(true);
    expect(drag(row, 0, -30)).toBe(false);
  });

  it("allows a horizontal move inside a row that has room", () => {
    const tabs = add(
      document.body,
      "div",
      { overflowX: "auto" },
      { scrollWidth: 500, clientWidth: 100 },
    );
    const tab = add(tabs, "button");
    expect(drag(tab, -30, 0)).toBe(false);
  });

  it("blocks a vertical move inside a horizontal row", () => {
    const tabs = add(
      document.body,
      "div",
      { overflowX: "auto", overflowY: "hidden" },
      { scrollWidth: 500, clientWidth: 100, scrollHeight: 300, clientHeight: 40 },
    );
    const tab = add(tabs, "button");
    expect(drag(tab, 0, -30)).toBe(true);
  });

  it("blocks a move in a tall box that does not scroll", () => {
    const box = add(
      document.body,
      "div",
      { overflowY: "hidden" },
      { scrollHeight: 500, clientHeight: 100 },
    );
    box.scrollTop = 50;
    expect(drag(add(box, "div"), 0, -30)).toBe(true);
  });

  it("blocks a pull-down in a scroller whose content fits, even with an overscrolled offset", () => {
    const list = add(
      document.body,
      "div",
      { overflowY: "auto" },
      { scrollHeight: 100, clientHeight: 100 },
    );
    // Safari reports an offset outside the range while it rubber-bands.
    list.scrollTop = 20;
    expect(drag(add(list, "div"), 0, 30)).toBe(true);
  });

  it("allows a vertical move in a textarea with taller content", () => {
    const box = add(document.body, "textarea", {}, { scrollHeight: 300, clientHeight: 60 });
    box.scrollTop = 20;
    expect(drag(box, 0, -30)).toBe(false);
  });

  it("allows a two-finger move on the bar", () => {
    const bar = add(document.body, "div");
    expect(drag(bar, 0, -30, 2)).toBe(false);
  });

  it("stops blocking after the returned function runs", () => {
    const bar = add(document.body, "div");
    unlock?.();
    unlock = undefined;
    expect(drag(bar, 0, -30)).toBe(false);
  });
});
