import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "@pi-spore/shared";
import Type, { type Static } from "typebox";
import { generateVAPIDKeys, sendNotification, WebPushError } from "web-push";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Vapid {
  /** `https://<host>` or `mailto:`; Apple refuses a `localhost` subject (ADR 0187). */
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Sends one encrypted push and answers the push service's HTTP status. */
export type PushSender = (target: PushTarget, payload: string, vapid: Vapid) => Promise<number>;

/** Apple's push service needs a TTL; `high` delivers at once (ADR 0187). */
export const sendWebPush: PushSender = async (target, payload, vapid) => {
  try {
    const result = await sendNotification(target, payload, {
      vapidDetails: vapid,
      TTL: 86_400,
      urgency: "high",
    });
    return result.statusCode;
  } catch (error) {
    if (error instanceof WebPushError) return error.statusCode;
    throw error;
  }
};

const VapidKeys = Type.Object({
  publicKey: Type.String({ minLength: 1 }),
  privateKey: Type.String({ minLength: 1 }),
});
type VapidKeys = Static<typeof VapidKeys>;

/** Reads the VAPID key pair, creating it (mode 0600) on first start, like the token file. Never log it. */
export function ensureVapidKeys(path: string): VapidKeys {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    try {
      return parse(VapidKeys, JSON.parse(text), "VAPID keys");
    } catch {
      throw new Error(`The VAPID keys in ${path} are broken; delete the file to make new ones`);
    }
  }
  const { publicKey, privateKey } = generateVAPIDKeys();
  writeFileSync(path, `${JSON.stringify({ publicKey, privateKey }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return { publicKey, privateKey };
}
