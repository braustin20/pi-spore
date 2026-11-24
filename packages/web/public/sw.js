// pi-spore's service worker: pushes and the taps on them, and nothing else (ADR 0196).
//
// The page at `/` carries the API token in a meta tag (ADR 0143), so this worker must not intercept
// or store any request: a cached copy of that page would keep the token where pi-spore cannot revoke
// it or clear it. Hence no `fetch` listener and no Cache API, and never add one.

/** The push payload (`PushPayload` in `@pi-spore/shared`), or nothing when it is missing or broken. */
function payloadOf(event) {
  try {
    const data =
      event.data && typeof event.data.json === "function" ? event.data.json() : undefined;
    return data && typeof data === "object" ? data : undefined;
  } catch {
    // A payload that is not JSON still gets a notification, so the subscription survives.
    return undefined;
  }
}

const text = (value) => (typeof value === "string" ? value : "");

/** The app badge is best effort: it must never stop a notification (ADR 0196). */
function setBadge(badge) {
  if (typeof badge !== "number" || typeof self.navigator?.setAppBadge !== "function") return;
  try {
    // Not awaited, and its rejection swallowed: the badge is not part of what the push waits for.
    Promise.resolve(self.navigator.setAppBadge(badge)).catch(() => {});
  } catch {
    // A phone with badging turned off in its settings still gets the notification.
  }
}

self.addEventListener("push", (event) => {
  const payload = payloadOf(event);
  // iOS drops a subscription after three silent pushes, so every push shows something (ADR 0196).
  event.waitUntil(
    self.registration.showNotification(text(payload?.title) || "pi-spore", {
      body: text(payload?.body),
      tag: text(payload?.tag) || undefined,
      data: { href: text(payload?.href) },
    }),
  );
  setBadge(payload?.badge);
});

/** The item's link is a hash link of this app, or the app itself. Nothing else is opened. */
function targetUrl(href) {
  const root = `${self.location.origin}/`;
  // The origin root plus a hash link is this app's page with that hash, so no URL parsing is
  // needed. A link that does not start with `#/` stays on this origin, at its root.
  return typeof href === "string" && href.startsWith("#/") ? `${root}${href}` : root;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetUrl(event.notification?.data?.href);
  event.waitUntil(
    (async () => {
      const [page] = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!page) return self.clients.openWindow(url);
      await page.focus();
      try {
        await page.navigate(url);
      } catch {
        // A page this worker does not control cannot be navigated, so open the link in a new one.
        return self.clients.openWindow(url);
      }
      return undefined;
    })(),
  );
});
