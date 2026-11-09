// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPanelResizing, onPanelResizeEnd, ResizeHandle } from "./resize-handle.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

function mount(props: { width?: number; grow?: 1 | -1 } = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  container = document.body.appendChild(document.createElement("div"));
  act(() => {
    createRoot(container as HTMLElement).render(
      <ResizeHandle
        label="Resize the thing"
        width={props.width ?? 300}
        min={200}
        max={320}
        grow={props.grow ?? 1}
        onChange={onChange}
        onReset={onReset}
      />,
    );
  });
  const handle = container.querySelector<HTMLElement>("[role=separator]");
  if (!handle) throw new Error("the handle did not render");
  // happy-dom has no pointer capture.
  handle.setPointerCapture = () => {};
  return { handle, onChange, onReset };
}

const press = (handle: HTMLElement, key: string, shiftKey = false) =>
  act(() => {
    handle.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });

const pointer = (handle: HTMLElement, type: string, clientX: number) =>
  act(() => {
    handle.dispatchEvent(
      new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true }),
    );
  });

describe("ResizeHandle", () => {
  it("shows its width and limits to assistive technology", () => {
    const { handle } = mount();
    expect(handle.getAttribute("aria-label")).toBe("Resize the thing");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(handle.getAttribute("aria-valuemin")).toBe("200");
    expect(handle.getAttribute("aria-valuemax")).toBe("320");
    expect(handle.tabIndex).toBe(0);
  });

  it("steps 16 px per arrow key and 64 px with Shift, clamped to the limits", () => {
    const { handle, onChange } = mount({ width: 300 });
    press(handle, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith(316);
    press(handle, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith(284);
    press(handle, "ArrowRight", true);
    expect(onChange).toHaveBeenLastCalledWith(320);
    press(handle, "ArrowLeft", true);
    expect(onChange).toHaveBeenLastCalledWith(236);
  });

  it("grows a right-side panel on ArrowLeft and ignores other keys", () => {
    const { handle, onChange } = mount({ grow: -1 });
    press(handle, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith(316);
    onChange.mockClear();
    press(handle, "ArrowUp");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets on a double-click", () => {
    const { handle, onReset } = mount();
    act(() => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("resizes by the drag distance and tells listeners once when the drag ends", () => {
    const { handle, onChange } = mount({ width: 300 });
    const ended = vi.fn();
    const stop = onPanelResizeEnd(ended);
    expect(isPanelResizing()).toBe(false);
    pointer(handle, "pointerdown", 100);
    expect(isPanelResizing()).toBe(true);
    expect(document.body.style.userSelect).toBe("none");
    pointer(handle, "pointermove", 110);
    expect(onChange).toHaveBeenLastCalledWith(310);
    pointer(handle, "pointermove", 500);
    expect(onChange).toHaveBeenLastCalledWith(320);
    pointer(handle, "pointerup", 500);
    expect(isPanelResizing()).toBe(false);
    expect(document.body.style.userSelect).toBe("");
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
    pointer(handle, "pointerdown", 0);
    pointer(handle, "pointerup", 0);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("subtracts the drag distance for a right-side panel", () => {
    const { handle, onChange } = mount({ width: 300, grow: -1 });
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 90);
    expect(onChange).toHaveBeenLastCalledWith(310);
    pointer(handle, "pointerup", 90);
  });
});
