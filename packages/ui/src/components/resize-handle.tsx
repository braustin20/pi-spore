import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { clampWidth, stepWidth } from "../panel-width.js";

let resizing = false;
const endListeners = new Set<() => void>();

/** True while a handle is being dragged. A terminal skips fitting then and fits once at the end. */
export function isPanelResizing(): boolean {
  return resizing;
}

/** Runs `listener` when a drag ends. Returns the function that stops it. */
export function onPanelResizeEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => void endListeners.delete(listener);
}

function setResizing(active: boolean): void {
  resizing = active;
  document.body.style.userSelect = active ? "none" : "";
  document.body.style.cursor = active ? "col-resize" : "";
  if (!active) for (const listener of endListeners) listener();
}

/**
 * A draggable edge for a side panel; the panel needs `position: relative`. `grow` is 1 for a panel on the left
 * (the handle sits on its right edge) and -1 for a panel on the right.
 */
export function ResizeHandle({
  label,
  width,
  min,
  max,
  grow,
  onChange,
  onReset,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  grow: 1 | -1;
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);

  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    setResizing(false);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    setResizing(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onChange(clampWidth(drag.current.width + grow * (event.clientX - drag.current.x), min, max));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = stepWidth(width, event.key, event.shiftKey, grow);
    if (next === undefined) return;
    event.preventDefault();
    onChange(clampWidth(next, min, max));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or key events; this is the WAI-ARIA window splitter.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      style={{ touchAction: "none" }}
      className={`group absolute inset-y-0 z-10 flex w-2 cursor-col-resize justify-center outline-none ${grow === 1 ? "-right-1" : "-left-1"}`}
    >
      <span className="h-full w-px bg-transparent group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}
