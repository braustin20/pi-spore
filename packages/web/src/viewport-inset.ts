const KEYBOARD_MIN_PX = 100;
const TEXT_FIELD =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="file"], [type="range"])';

/**
 * Keeps `--app-height` and `--app-top` in step with the visual viewport on phones (ADR 0159). On resume the
 * page is reset to the top, so the first swipe works without a tap. Returns the cleanup.
 */
export function followVisualViewport(win: Window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const doc = win.document;
  const root = doc.documentElement.style;
  const update = () => {
    // iOS does not shrink the layout viewport for the keyboard, so a big gap means the keyboard is open.
    // Without this check, a pan of the visual viewport would move the app.
    const keyboardOpen = viewport.height < doc.documentElement.clientHeight - KEYBOARD_MIN_PX;
    root.setProperty("--app-height", `${viewport.height}px`);
    root.setProperty("--app-top", keyboardOpen ? `${viewport.offsetTop}px` : "0px");
    doc.documentElement.toggleAttribute("data-keyboard-open", keyboardOpen);
  };
  let frame = 0;
  const onResume = () => {
    update();
    // The viewport height can still be stale right at resume, so read it once more after the next frame.
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(update);
    if (win.scrollX !== 0 || win.scrollY !== 0) win.scrollTo(0, 0);
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") return onResume();
    // iOS keeps a field focused on resume with no keyboard, which would hide the top bar (ADR 0190).
    if (doc.activeElement?.matches(TEXT_FIELD)) (doc.activeElement as HTMLElement).blur();
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pageshow", onResume);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onResume);
    win.cancelAnimationFrame(frame);
    doc.documentElement.removeAttribute("data-keyboard-open");
    root.removeProperty("--app-height");
    root.removeProperty("--app-top");
  };
}
