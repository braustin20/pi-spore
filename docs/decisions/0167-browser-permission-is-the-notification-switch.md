# 0167. The browser permission is the only desktop notification switch

- Status: Accepted
- Date: 2026-11-09
- Requirements: R15.2, R17.1

## Context

- Desktop notifications (R15.2) show only when the browser grants permission. The attention web module asks for it
  with a button and never on page load.
- No pi-spore setting turns them off. To stop them, the user blocks notifications for the site in the browser.
- R17 now resolves settings from every source and shows where each came from, so a `notifications.desktop` key
  could be added.
- A server setting is global: it would apply to every browser and device that opens pi-spore. The browser
  permission is per browser, which matches where a notification shows.

## Decision

- No desktop notification setting. The browser permission stays the only switch.

## Consequences

- No settings key, resolver entry, or Settings page row for notifications.
- To mute one device, the user blocks notifications in that browser. Muting all devices at once is not possible.
- A later need for a pi-spore switch (for example, quiet hours or a mute for all devices) needs a new ADR.
