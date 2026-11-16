const KEYBOARD_MIN_PX = 100;

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
  };
  const onResume = () => {
    update();
    if (win.scrollX !== 0 || win.scrollY !== 0) win.scrollTo(0, 0);
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") onResume();
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
    root.removeProperty("--app-height");
    root.removeProperty("--app-top");
  };
}
