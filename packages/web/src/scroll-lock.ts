const EDGE_SLOP = 1;

function canScroll(el: Element, axis: "x" | "y", delta: number, win: Window): boolean {
  const style = win.getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (el.tagName !== "TEXTAREA" && overflow !== "auto" && overflow !== "scroll") return false;
  const [pos, view, size] =
    axis === "y"
      ? [el.scrollTop, el.clientHeight, el.scrollHeight]
      : [el.scrollLeft, el.clientWidth, el.scrollWidth];
  // Safari reports offsets outside the range while it rubber-bands, so content that fits never scrolls.
  if (size <= view) return false;
  // A finger moving down or right pulls content toward the start, so it needs room before the start.
  return delta > 0 ? pos > EDGE_SLOP : pos + view < size - EDGE_SLOP;
}

/**
 * Stops a one-finger drag from reaching the document unless an inner scroller can use it. iOS gives such a
 * drag to the document, which bounces and moves the fixed app with it (ADR 0159). Returns the cleanup.
 */
export function lockDocumentScroll(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) throw new Error("lockDocumentScroll needs a document with a window");
  let startX = 0;
  let startY = 0;
  const onStart = (event: TouchEvent) => {
    const first = event.touches[0];
    if (first) {
      startX = first.clientX;
      startY = first.clientY;
    }
  };
  const onMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    const delta = axis === "y" ? dy : dx;
    for (
      let el = event.target instanceof Element ? event.target : null;
      el && el !== doc.documentElement;
      el = el.parentElement
    ) {
      if (canScroll(el, axis, delta, win)) return;
    }
    event.preventDefault();
  };
  doc.addEventListener("touchstart", onStart, { passive: true });
  doc.addEventListener("touchmove", onMove, { passive: false });
  return () => {
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
  };
}
