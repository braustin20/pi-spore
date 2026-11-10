// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./menu.js";
import { TooltipProvider } from "./tooltip.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(disabled = false) {
  act(() =>
    root?.render(
      <TooltipProvider delayDuration={0}>
        <Menu
          tooltip="New chat"
          trigger={
            <button type="button" disabled={disabled}>
              +
            </button>
          }
        >
          <MenuItem>One</MenuItem>
        </Menu>
      </TooltipProvider>,
    ),
  );
  const button = document.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("no trigger");
  return button;
}

function hover(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    vi.advanceTimersByTime(10);
  });
}

const tooltip = () => document.querySelector("[role=tooltip]");

describe("Menu tooltip", () => {
  it("shows the tooltip on hover", () => {
    hover(render());
    expect(tooltip()?.textContent).toBe("New chat");
  });

  it("hides the tooltip while the menu is open", async () => {
    const button = render();
    hover(button);
    expect(tooltip()).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    expect(document.querySelector("[role=menu]")).not.toBeNull();
    expect(tooltip()).toBeNull();
  });

  it("shows the tooltip of a disabled trigger on hover over its wrapper", () => {
    const wrapper = render(true).parentElement;
    if (!wrapper) throw new Error("no wrapper");
    hover(wrapper);
    expect(tooltip()?.textContent).toBe("New chat");
  });
});
