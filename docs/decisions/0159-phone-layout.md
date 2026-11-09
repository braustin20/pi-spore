# 0159. A phone layout below 768 px

- Status: Accepted; changes the "Not planned" line that [0143](0143-phone-over-tailscale-serve.md) left in the vision
- Date: 2026-11-09
- Requirements: R1.1, R15.2

## Context

- ADR 0143 lets a phone reach pi-spore over `tailscale serve`, and kept "a layout made for phones" as not planned.
- On a phone the wide layout does not fit: three panes, fixed widths, a 56 px rail. The user wants to read chats,
  answer questions and approvals, and merge from a phone.

## Decision

- One breakpoint: a phone is `width < 48rem` (768 px), Tailwind's `max-md:`. CSS uses `max-md:`. JS uses
  `usePhone()` in `packages/ui/src/phone.ts`, the only place JS knows the number. At 768 px and above the layout
  stays as it was.
- Hover-only controls also show on screens that cannot hover, through a `touch:` variant (`@media (hover: none)`).
- On phones a page shows one pane at a time. Which pane is open lives in the hash after the path:
  `#/workspaces/<id>?pane=changes`. The router ignores the query. `openPane` adds a history entry, so Back closes
  the pane; `switchPane` replaces it; `closePane` goes Back when the entry is ours, else replaces the hash, so a
  reload never leaves the site.
- On phones the root follows `visualViewport`, so the composer stays above the iOS keyboard. The viewport meta has
  `interactive-widget=resizes-content` for Android. Fields use 16 px text, so iOS does not zoom.
- A web app manifest and icons let "Add to Home Screen" open pi-spore without the browser bar.
- No service worker. Phone browsers show notifications only from a service worker, so the notification button
  hides on phones. Push is out of scope.
- No special mobile terminal. The xterm.js terminal shows as it is.

## Consequences

- New UI must fit 390 px: add `max-md:` classes, and keep wide blocks (code, diffs, tables) scrolling inside
  themselves.
- The composer's controls row (image, model, thinking, Send) is one line at every width; the model select takes
  the free space. The user asked for this on the desktop too.
- A phone keyboard has no Esc, Ctrl, or arrow keys, and Android keyboards may double text in xterm.js (xterm.js
  issues #3600 and #5377). Terminals on phones are for reading and short commands.
