import { describe, expect, it } from "vitest";
import { defaultWidths, layoutPanels } from "./panel-layout.js";

describe("layoutPanels", () => {
  it("keeps the chosen widths when they fit", () => {
    const layout = layoutPanels({ window: 1600, list: 300, right: 400, wide: false });
    expect(layout.list).toEqual({ width: 300, min: 200, max: 480 });
    // 1600 - 300 (list) - 360 (chat) = 940, below 70% of the window.
    expect(layout.right).toEqual({ width: 400, min: 280, max: 940 });
  });

  it("keeps each panel inside its own limits", () => {
    expect(layoutPanels({ window: 1600, list: 100, right: 100, wide: false })).toMatchObject({
      list: { width: 200 },
      right: { width: 280 },
    });
    expect(layoutPanels({ window: 1600, list: 900, right: 400, wide: false }).list.width).toBe(480);
  });

  it("caps the right panel at 70% of the window", () => {
    const layout = layoutPanels({ window: 2000, list: 200, right: 1800, wide: false });
    expect(layout.right).toMatchObject({ width: 1400, max: 1400 });
  });

  it("keeps 360 px for the chat, shrinking the right panel first", () => {
    const layout = layoutPanels({ window: 1000, list: 300, right: 500, wide: false });
    expect(layout.right).toMatchObject({ width: 340, max: 340 });
    expect(layout.list).toMatchObject({ width: 300, max: 300 });
  });

  it("lets the minimums win when the window is too narrow for all three", () => {
    const layout = layoutPanels({ window: 800, list: 300, right: 500, wide: false });
    expect(layout.right.width).toBe(280);
    expect(layout.list.width).toBe(200);
  });

  it("gives a wide tab the larger of the chosen width and its own default", () => {
    // The wide default is 640 px or half the window, whichever is smaller.
    expect(layoutPanels({ window: 1600, list: 300, right: 320, wide: true }).right.width).toBe(640);
    expect(layoutPanels({ window: 1600, list: 300, right: 700, wide: true }).right.width).toBe(700);
    expect(layoutPanels({ window: 1100, list: 200, right: 320, wide: true }).right.width).toBe(540);
    expect(layoutPanels({ window: 1000, list: 256, right: 320, wide: true }).right.width).toBe(384);
  });

  it("counts a closed list as 40 px and a closed or absent right panel as 40 or 0 px", () => {
    const closed = layoutPanels({ window: 1000, list: "closed", right: "closed", wide: false });
    expect(closed.list).toEqual({ width: 40, min: 40, max: 40 });
    expect(closed.right).toEqual({ width: 40, min: 40, max: 40 });
    const absent = layoutPanels({ window: 1000, list: 480, right: "absent", wide: false });
    expect(absent.right).toEqual({ width: 0, min: 0, max: 0 });
    expect(absent.list).toMatchObject({ width: 480, max: 480 });
    const wideOpen = layoutPanels({ window: 1000, list: "closed", right: 900, wide: false });
    expect(wideOpen.right).toMatchObject({ width: 600, max: 600 });
  });
});

describe("defaultWidths", () => {
  it("matches the old fixed widths, a step wider on large windows", () => {
    expect(defaultWidths(1279)).toEqual({ list: 256, right: 320 });
    expect(defaultWidths(1280)).toEqual({ list: 288, right: 352 });
  });
});
