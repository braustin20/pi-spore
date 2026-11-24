# 0196. Phone notifications through Web Push and a service worker

- Status: Accepted; changes the "No service worker ... Push is out of scope" line of [0159](0159-phone-layout.md);
  extends [0167](0167-browser-permission-is-the-notification-switch.md)
- Renumbered from 0187 on 2026-11-23; old commits cite the old number.
- Date: 2026-11-16
- Requirements: R1.1, R15.2

## Context

- The user runs pi-spore on an iPhone as a Home Screen web app, over `tailscale serve` (ADR 0143), which gives
  HTTPS. They want a phone notification when pi-spore needs them, also when the app is closed.
- ADR 0159 left out a service worker, so phones got no notifications. iOS allows notifications in a web app only from
  a service worker, and only through push when the app is closed.
- What WebKit and Apple require (checked 2026-11-16: WebKit blog "Web Push for Web Apps on iOS and iPadOS", WebKit
  commit b6e8acd, Apple "Sending web push notifications in web apps and browsers"):
  - iOS and iPadOS 16.4 or later. Push works only in a Home Screen web app: the manifest's `display` is
    `standalone` (ours is). In a Safari tab `Notification` is undefined. From iOS 26 every site added to the Home
    Screen opens as a web app by default.
  - Permission only from a user tap. Without one, `Notification.requestPermission()` resolves `denied` with no
    prompt. After `granted`, `pushManager.subscribe` works without a new tap.
  - Every push must show a notification (`userVisibleOnly: true`). WebKit removes a subscription after three
    silent pushes.
  - The Badging API (`navigator.setAppBadge`, `navigator.clearAppBadge`) works in the page and in the service
    worker of a Home Screen web app, iOS 16.4 or later. The user can turn badges off in iOS settings.
  - Apple's push service takes payloads up to 4 KB and needs a `TTL` header. `Urgency: high` delivers at once. 404
    and 410 mean the subscription is gone. The VAPID token's subject must be an `https:` URL or a `mailto:`
    address; a `localhost` subject fails with 403 `BadJwtToken`.
- The page at `/` holds the API token in a meta tag (ADR 0143). A cache of that page would keep the token where
  pi-spore does not control it.

## Decision

- One service worker, `/sw.js` (from `packages/web/public/`), scope `/`. It listens only to `push` and
  `notificationclick`. It has **no `fetch` handler and caches nothing**. A test fails if another listener is added.
- `push`: show a notification with the payload's title, body, and tag, and set the app badge to the payload's
  Home count. The badge is best effort: it never blocks or prevents the notification. `notificationclick`: focus an
  open pi-spore window and navigate it to the item's link (`WindowClient.navigate`), or open a new window on that
  link.
- The server sends pushes with the `web-push` package (VAPID, RFC 8291 encryption). Each push goes to the push
  service of the device's browser, Apple's for iOS. This is outward-facing: the payload is encrypted end to end, so
  the push service cannot read it, but it sees that a push happened and when.
- The payload holds only: the title and body of `notification(item)` (each cut to 200 characters), the item's
  link, its tag, and the Home count. Never the token or anything else pi-spore keeps secret. The body is what the
  agent wrote (a question, a dialog's title, an error's first line), the same text a desktop notification shows;
  the user wants to read it on the lock screen.
- Pushes go for new chat items only: question, approval, dialog, failed, finished. Notices (waiting PR, due card,
  usage warning) do not push. When the server starts it builds the inbox once and sends nothing for it: items
  already there are not news, as in the web store.
- No push while a desktop page has focus: that page shows a toast for the item. A desktop page (the toast rule,
  `(hover: hover) and (pointer: fine)`) reports its focus to the server when it loads, on focus, every 30 seconds
  while focused, and on blur. The server keeps each report in memory for 60 seconds, so a closed tab stops counting
  by itself.
- The browser permission stays the switch (ADR 0167). Turning push on is a tap on Home on each phone. Turning it off
  removes that device's subscription. A desktop browser gets pushes only if it subscribed, and Home offers the
  button only on a phone that runs the app standalone.
- The VAPID key pair is made once, on first start, in `~/.pi-spore/vapid.json`, mode 0600, like the token file. It
  is never logged. The subject is `https://<the Host the phone subscribed through>`.
- A push service that answers 404 or 410 deletes that subscription. A failed push is logged by subscription id,
  never by endpoint URL.

## Consequences

- The phone gets notifications with the app closed, and a tap opens the item.
- The home screen icon shows the Home count after each push. Opening Home clears it.
- Apple (or another browser's push service) learns when pi-spore sends a push, but not what it says.
- Deleting `vapid.json` makes new keys; every existing subscription then fails, and each phone must turn
  notifications on again.
- A service worker is now part of the web app. Any change to it must keep it free of `fetch` and caches.
