# 0185. The phone document never scrolls

- Status: Accepted; adds to [0159](0159-phone-layout.md)
- Date: 2026-11-15
- Requirements: R1.1, R15.2

## Context

- In the iOS home screen app, a drag that starts on something that cannot scroll (the chat composer, the top bar,
  a short page) goes to the document. The document bounces, and the fixed root of ADR 0159 moves with it, top bar
  too. A drag that starts in a real scroller, such as the chat messages, stays there.
- The root copied `visualViewport.offsetTop` at all times, so any pan of the visual viewport moved the app.
- After a return to the app, the first swipe moved the app again until the user tapped once.

## Decision

- On phones, `html` and `body` have `overflow: hidden` and `overscroll-behavior: none`.
- On phones, `lockDocumentScroll` (`packages/web/src/scroll-lock.ts`) cancels a one-finger `touchmove` unless an
  element under the finger can scroll on the drag's axis, in its direction. Two-finger moves pass, so pinch zoom
  works. iOS sometimes ignores the CSS alone; libraries such as Headless UI and body-scroll-lock use the same
  guard.
- `followVisualViewport` (`packages/web/src/viewport-inset.ts`) sets `--app-top` to `offsetTop` only while the
  keyboard is open: the visual viewport is more than 100 px shorter than the layout viewport. Otherwise it is 0.
  It updates again on `visibilitychange` and `pageshow`, and scrolls a scrolled document back to the top.

## Consequences

- ADR 0159's keyboard rule holds: the composer stays above the iOS keyboard.
- A new scroll pane needs `overflow-y: auto` or `overflow-x: auto` on the element that scrolls. A pane that
  scrolls some other way (a canvas, the xterm.js screen) gets no touch drags on phones.
- happy-dom has no layout or touch scrolling. Unit tests cover the guard's and the inset's logic; the bounce
  itself is checked on a real phone.
