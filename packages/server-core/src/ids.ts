import { randomBytes } from "node:crypto";

// Crockford base32, as in ULID: no I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-style id: 10 characters of millisecond time, then 16 random characters. Sorts by creation time. */
export function newId(now: () => number = Date.now): string {
  let time = now();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = ALPHABET[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 32];
  return head + tail;
}
