const KEYBOARD_MIN_PX = 100;
const TEXT_FIELD =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="file"], [type="range"])';

/**
 * Keeps `--app-height` and `--app-top` in step with the visual viewport on phones (ADR 0159). On resume the
 * page is reset to the top, so the first swipe works without a tap. iOS can keep a stale short viewport after
 * resume, so a display flip on `#root` makes WebKit measure it again (ADR 0192). Returns the cleanup.
 */
export function followVisualViewport(win: Window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const doc = win.document;
  const root = doc.documentElement.style;
  const fieldFocused = () => doc.activeElement?.matches(TEXT_FIELD) === true;
  // The full height is only trusted with no focused field, as the keyboard shrinks the viewport.
  let full = 0;
  let width = viewport.width;
  const update = () => {
    if (viewport.width !== width) {
      width = viewport.width;
      full = 0;
    }
    if (!fieldFocused()) full = Math.max(full, viewport.height);
    // iOS does not shrink the layout viewport for the keyboard, so a big gap means the keyboard is open.
    // Without this check, a pan of the visual viewport would move the app.
    const keyboardOpen = viewport.height < doc.documentElement.clientHeight - KEYBOARD_MIN_PX;
    root.setProperty("--app-height", `${viewport.height}px`);
    root.setProperty("--app-top", keyboardOpen ? `${viewport.offsetTop}px` : "0px");
    doc.documentElement.toggleAttribute("data-keyboard-open", keyboardOpen);
  };
  let heals = 0;
  const heal = () => {
    if (fieldFocused() || viewport.scale > 1 || viewport.height >= full - 4) return;
    const app = doc.getElementById("root");
    if (!app) return;
    // WebKit drops the scroll position of a box under display: none.
    const scrolled = [...app.querySelectorAll("*")]
      .filter((el) => el.scrollTop > 0)
      .map((el) => [el, el.scrollTop] as const);
    app.style.display = "none";
    void app.offsetHeight;
    app.style.display = "";
    for (const [el, top] of scrolled) el.scrollTop = top;
    heals++;
    doc.documentElement.setAttribute("data-viewport-heals", String(heals));
    update();
  };
  let frame = 0;
  let healFrame = 0;
  const onResume = () => {
    update();
    // The viewport height can still be stale right at resume, so read it once more after the next frame.
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      update();
      heal();
    });
    if (win.scrollX !== 0 || win.scrollY !== 0) win.scrollTo(0, 0);
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") return onResume();
    // iOS keeps a field focused on resume with no keyboard, which would hide the top bar (ADR 0190).
    if (fieldFocused()) (doc.activeElement as HTMLElement).blur();
  };
  const onResize = () => {
    update();
    if (fieldFocused()) return;
    win.cancelAnimationFrame(healFrame);
    healFrame = win.requestAnimationFrame(heal);
  };
  update();
  viewport.addEventListener("resize", onResize);
  viewport.addEventListener("scroll", update);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pageshow", onResume);
  return () => {
    viewport.removeEventListener("resize", onResize);
    viewport.removeEventListener("scroll", update);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onResume);
    win.cancelAnimationFrame(healFrame);
    win.cancelAnimationFrame(frame);
    doc.documentElement.removeAttribute("data-keyboard-open");
    doc.documentElement.removeAttribute("data-viewport-heals");
    root.removeProperty("--app-height");
    root.removeProperty("--app-top");
  };
}
