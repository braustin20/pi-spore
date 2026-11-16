// Home's push switch for a phone (ADR 0187). iOS gives a web app notifications only through Web
// Push, and only when the app runs from the Home Screen, so this button is for that one case: a
// desktop browser keeps the plain permission button in `web.tsx`.
import { useApi } from "@pi-spore/module-api";
import { PushSubscriptionRequest, parse } from "@pi-spore/shared";
import { Button, Chip, usePhone } from "@pi-spore/ui";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import Type from "typebox";

/** The manifest's `display` is `standalone`, so this is true only in a Home Screen web app. */
const STANDALONE_QUERY = "(display-mode: standalone)";

/** The VAPID public key, from `GET attention/push/key`. */
const PushKey = Type.Object({ publicKey: Type.String({ minLength: 1, maxLength: 512 }) });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** iOS has push only in a Home Screen web app, never in a Safari tab (ADR 0187). */
function isStandalone(): boolean {
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isPushCapable(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * The subscription to send the server, checked against the server's own request schema.
 * `PushSubscription.toJSON()` types every field as optional, and a phone that gives no keys cannot
 * be pushed.
 */
function bodyOf(subscription: PushSubscription): PushSubscriptionRequest {
  const { endpoint, keys } = subscription.toJSON();
  return parse(PushSubscriptionRequest, { endpoint, keys }, "push subscription");
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** `applicationServerKey` wants the key's bytes; the server sends it as base64url. */
function base64UrlToBytes(key: string): Uint8Array<ArrayBuffer> {
  const normal = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type PushState =
  | { phase: "checking" }
  | { phase: "off" }
  | { phase: "on" }
  | { phase: "blocked" }
  | { phase: "error"; text: string };

/** The chip for a browser that will not allow notifications, on a phone and on a desktop. */
export function BlockedChip() {
  return (
    <Chip title="Allow notifications for this site in the browser settings">
      Notifications blocked
    </Chip>
  );
}

/** Turns phone push on and off with one tap, which is what iOS needs for permission (ADR 0187). */
export function PhonePushButton() {
  const api = useApi();
  const phone = usePhone();
  const [state, setState] = useState<PushState>({ phase: "checking" });
  const shows = phone && isPushCapable() && isStandalone();

  useEffect(() => {
    if (!shows) return;
    let current = true;
    void currentSubscription()
      .then((subscription) => {
        if (!current) return;
        if (!subscription) {
          setState(Notification.permission === "denied" ? { phase: "blocked" } : { phase: "off" });
          return;
        }
        setState({ phase: "on" });
        // A phone keeps its subscription across a server restart. Sending it again is idempotent, so
        // this gives the server back a row it lost.
        void api.send("POST", "attention/push/subscriptions", bodyOf(subscription)).catch(() => {});
      })
      .catch((caught: unknown) => {
        if (current) setState({ phase: "error", text: message(caught) });
      });
    return () => {
      current = false;
    };
  }, [api, shows]);

  /** Every step after the tap runs on promises, so the tap stays the permission gesture. */
  const turnOn = async () => {
    try {
      // iOS asks only from the tap, so this is the first call: nothing is awaited before it.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { phase: "blocked" } : { phase: "off" });
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = parse(PushKey, await api.get("attention/push/key"), "push key");
      const subscription = await registration.pushManager.subscribe({
        // iOS drops a subscription that got a silent push, so every push must be visible.
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      });
      await api.send("POST", "attention/push/subscriptions", bodyOf(subscription));
      setState({ phase: "on" });
    } catch (caught) {
      setState({ phase: "error", text: message(caught) });
    }
  };

  const turnOff = async () => {
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        await api.send("DELETE", "attention/push/subscriptions", {
          endpoint: subscription.endpoint,
        });
      }
      setState({ phase: "off" });
    } catch (caught) {
      setState({ phase: "error", text: message(caught) });
    }
  };

  if (!shows || state.phase === "checking") return null;
  if (state.phase === "blocked") return <BlockedChip />;
  if (state.phase === "on")
    return (
      <>
        <Chip tone="ok">Notifications are on</Chip>
        <Button size="sm" variant="ghost" onClick={() => void turnOff()}>
          Turn off
        </Button>
      </>
    );
  return (
    <>
      <Button size="sm" onClick={() => void turnOn()}>
        <Bell />
        Turn on notifications
      </Button>
      {state.phase === "error" && (
        <span className="text-xs whitespace-pre-wrap text-muted">{state.text}</span>
      )}
    </>
  );
}
