# 0192. A short phone viewport heals by a display flip on the root

- Status: Accepted; adds to [0159](0159-phone-layout.md), [0185](0185-the-phone-document-never-scrolls.md), and
  [0190](0190-phone-top-rows-hide-only-with-the-keyboard.md)
- Date: 2026-11-22
- Requirements: R1.1, R15.2

## Context

- In the iOS home screen app, after a return to the app with the keyboard open before, iOS can report a visual
  viewport that is about 50 px shorter than the layout viewport, with no keyboard. On an iPhone 402×874 it was 761
  in place of 812. No later `resize` brings it back.
- The keyboard check needs a gap of more than 100 px, so it says "closed", and the root is sized to the short
  height. iOS also draws the page about 50 pt too high: the top bar sits under the status bar and a band shows
  under the composer. The ADR 0190 blur and the scroll reset do not fix it.
- This matches WebKit bugs 301857 (the viewport shrinks after the keyboard closes) and 300523 (on iPhones with a
  Dynamic Island the viewport moves up when the keyboard closes), both on iOS 26.
- A known workaround: set `display: none` on a full-height element, force a reflow, and clear it. WebKit then
  measures the viewport again.

## Decision

- `followVisualViewport` keeps the full height: the largest `visualViewport.height` seen while no text field has
  focus. A change of `visualViewport.width`, such as a rotation, resets it.
- When no text field has focus, the page is not pinch-zoomed, and the viewport is more than 4 px shorter than the
  full height, it heals: it saves the `scrollTop` of each scrolled box in `#root`, sets `#root` to
  `display: none`, reads `offsetHeight`, clears `display`, puts the scroll positions back, and reads the viewport
  again.
- It tries to heal in the second read on resume (ADR 0190), and on the next frame after a `visualViewport`
  `resize` with no focused field. There are no timers.
- `<html>` carries `data-viewport-heals` with the count of heals, for the phone check.

## Consequences

- With the keyboard open a text field has focus, so the keyboard never causes a flip.
- A flip costs one reflow. It runs only when the viewport is short with no field focused.
- happy-dom has no layout. Unit tests cover when the flip runs and that scroll positions stay; the real heal is
  checked on an iPhone.
