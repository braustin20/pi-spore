# 0190. Phone top rows hide only while the keyboard is open

- Status: Accepted; adds to [0159](0159-phone-layout.md) and [0185](0185-the-phone-document-never-scrolls.md)
- Date: 2026-11-18
- Requirements: R1.1, R15.2

## Context

- On phones, rows marked `data-hide-while-typing` (the top bar, the workspace pane row) hid whenever a text field
  had focus.
- In the iOS home screen app, after a return to the app (from a push notification or the app switcher), the
  composer can keep focus with no keyboard. The top bar stayed hidden.
- On resume, `visualViewport.height` can still hold the height from when the keyboard was open. The root was
  sized once with it, which left an empty band under the composer.

## Decision

- `followVisualViewport` sets `data-keyboard-open` on `<html>` while its keyboard check is true: the visual
  viewport is more than 100 px shorter than the layout viewport.
- The hide rule needs both `html[data-keyboard-open]` and a focused text field. Focus alone keeps the top rows.
- When the page becomes hidden, the focused text field is blurred, so the keyboard closes before iOS suspends the
  app. Unsent text is kept per chat, so nothing is lost.
- On `visibilitychange` (visible) and `pageshow`, the viewport is read now and again on the next animation frame.

## Consequences

- ADR 0159's keyboard rule holds: while the user types with the keyboard open, the top rows step aside and the
  composer stays above the keyboard.
- A pinch zoom shrinks the visual viewport too, but with no focused field the rows stay.
- happy-dom has no keyboard or layout. Unit tests cover the attribute, the blur, and the second read; the real
  resume is checked on an iPhone.
