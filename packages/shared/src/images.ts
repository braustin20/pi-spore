import type { IMAGE_TYPES } from "./agents.js";

/** Pure image helpers that the server and the web share (ADR 0060, ADR 0186). No Node imports. */
export type ImageType = (typeof IMAGE_TYPES)[number];

/** The first bytes of each image type, so a file or upload is what its type says. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  const starts = (prefix: readonly number[], at = 0) =>
    prefix.every((byte, index) => bytes[at + index] === byte);
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(ascii("GIF87a")) || starts(ascii("GIF89a"))) return "image/gif";
  if (starts(ascii("RIFF")) && starts(ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

const TYPE_OF_EXTENSION: Readonly<Record<string, ImageType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** The image type a path's extension names, in any case; undefined for any other file. */
export function imageTypeOfPath(path: string): ImageType | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? TYPE_OF_EXTENSION[name.slice(dot).toLowerCase()] : undefined;
}

/** Response headers for image bytes: the declared type only, and nothing in it may run. */
export function imageHeaders(mimeType: ImageType, cache: string): Record<string, string> {
  return {
    "content-type": mimeType,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
}
