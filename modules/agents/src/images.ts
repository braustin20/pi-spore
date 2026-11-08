import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import { IMAGE_TYPES, type ImageRef, type PromptImage } from "@pi-spore/shared";

export type ImageType = (typeof IMAGE_TYPES)[number];

const MIB = 1024 * 1024;

/** The first bytes of each image type, so a file or upload is what its type says. */
function sniff(bytes: Uint8Array): ImageType | undefined {
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

const isImageType = (type: string): type is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(type);

const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/**
 * Checks the images of a prompt: at most `maxCount`, each at most `maxBytes` decoded, and bytes that match the type
 * they claim. Returns them as Pi's `ImageContent` blocks.
 */
export function checkPromptImages(
  images: readonly PromptImage[],
  limits: { maxBytes: number; maxCount: number },
): { type: "image"; data: string; mimeType: string }[] {
  if (images.length > limits.maxCount) {
    throw new ApiError(
      400,
      "too_many_images",
      `A message takes at most ${limits.maxCount} images; this one has ${images.length}`,
    );
  }
  return images.map((image, index) => {
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > limits.maxBytes) {
      throw new ApiError(
        413,
        "image_too_large",
        `Image ${index + 1} is ${formatMib(bytes.length)}; the limit is ${formatMib(limits.maxBytes)}`,
      );
    }
    const claimed: string = image.mimeType;
    if (sniff(bytes) !== claimed) {
      throw new ApiError(
        400,
        "bad_image",
        `Image ${index + 1} is not a ${claimed.slice("image/".length).toUpperCase()} file`,
      );
    }
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}

/** Replaces every Pi image block (`{ type: "image", data, mimeType }`) in `value`. Unchanged parts are shared. */
function mapImages<T>(
  value: T,
  replace: (image: { data: string; mimeType: string }) => unknown,
): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const mapped = mapImages(item, replace);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return (changed ? next : value) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  if (
    object.type === "image" &&
    typeof object.data === "string" &&
    typeof object.mimeType === "string"
  )
    return replace({ data: object.data, mimeType: object.mimeType }) as T;
  let copy: Record<string, unknown> | undefined;
  for (const [key, field] of Object.entries(object)) {
    const mapped = mapImages(field, replace);
    if (mapped !== field) {
      copy ??= { ...object };
      copy[key] = mapped;
    }
  }
  return (copy ?? object) as T;
}

interface Cached {
  mimeType: string;
  bytes: Buffer;
}

/**
 * Keeps image data out of snapshots and live events (ADR 0060). Each image block becomes an `ImageRef` named by the
 * SHA-256 of its base64 data. The decoded bytes stay in a cache bounded by `cacheBytes`; a page that asks for an
 * image the cache has dropped gets it from the chat's session file, where Pi keeps every image it saw.
 */
export class ChatImages {
  /** The refs each agent has shown, so one chat cannot read another chat's images. */
  private readonly known = new Map<string, Set<string>>();
  /** Insertion order is use order: the first entry is dropped first. */
  private readonly cache = new Map<string, Cached>();
  private cached = 0;

  constructor(private readonly cacheBytes: number) {}

  /** `value` with its image blocks replaced by refs. */
  strip<T>(agentId: string, value: T): T {
    return mapImages(value, (image) => {
      const ref = createHash("sha256").update(image.data).digest("hex");
      let known = this.known.get(agentId);
      if (!known) {
        known = new Set();
        this.known.set(agentId, known);
      }
      known.add(ref);
      const hit = this.cache.get(ref);
      const bytes = hit?.bytes ?? Buffer.from(image.data, "base64");
      this.remember(ref, { mimeType: image.mimeType, bytes });
      const block: ImageRef = { type: "image", mimeType: image.mimeType, ref, bytes: bytes.length };
      return block;
    });
  }

  /** Drops what the chat showed. Cached bytes are shared by content and age out by size. */
  forget(agentId: string): void {
    this.known.delete(agentId);
  }

  knows(agentId: string, ref: string): boolean {
    return this.known.get(agentId)?.has(ref) === true;
  }

  /** The image from the cache, or from `reload` (the chat's history with its image data) when it was dropped. */
  async read(ref: string, reload: () => Promise<unknown>): Promise<Cached | undefined> {
    const hit = this.cache.get(ref);
    if (hit) {
      this.remember(ref, hit);
      return hit;
    }
    let found: Cached | undefined;
    mapImages(await reload(), (image) => {
      if (!found && createHash("sha256").update(image.data).digest("hex") === ref)
        found = { mimeType: image.mimeType, bytes: Buffer.from(image.data, "base64") };
      return image;
    });
    if (found) this.remember(ref, found);
    return found;
  }

  private remember(ref: string, entry: Cached): void {
    const old = this.cache.get(ref);
    if (old) {
      this.cache.delete(ref);
      this.cached -= old.bytes.length;
    }
    if (entry.bytes.length > this.cacheBytes) return;
    this.cache.set(ref, entry);
    this.cached += entry.bytes.length;
    for (const [oldest, value] of this.cache) {
      if (this.cached <= this.cacheBytes) break;
      this.cache.delete(oldest);
      this.cached -= value.bytes.length;
    }
  }
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

export function servableType(mimeType: string): ImageType {
  if (!isImageType(mimeType))
    throw new ApiError(415, "unsupported_image", `The chat does not show ${mimeType} images`);
  return mimeType;
}

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Reads an image file an agent linked in a message (ADR 0060). `path` is absolute or relative to the workspace
 * folder. It is served only when, after resolving symlinks, it is inside one of `roots`, has an image extension,
 * is a regular file of at most `maxBytes`, and its bytes are of the type its extension says.
 */
export async function readLinkedImage(
  path: string,
  base: string,
  roots: readonly string[],
  maxBytes: number,
): Promise<{ mimeType: ImageType; bytes: Buffer }> {
  if (path.includes("\0")) throw new ApiError(400, "bad_path", "The path has a NUL character");
  const notFound = () => new ApiError(404, "image_not_found", `No image at ${path}`);
  const requested = isAbsolute(path) ? path : resolve(base, path);
  const real = await realpath(requested).catch(() => {
    throw notFound();
  });
  const realRoots = (
    await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))
  ).filter((root): root is string => root !== undefined);
  if (!realRoots.some((root) => inside(real, root))) {
    throw new ApiError(
      403,
      "outside_workspace",
      "The chat shows only images inside the workspace folder or its artifacts folder",
    );
  }
  // The real name counts, so `shot.png` linking to `.env` is refused.
  const mimeType = TYPE_OF_EXTENSION[extname(real).toLowerCase()];
  if (!mimeType)
    throw new ApiError(415, "not_an_image", "The chat shows only PNG, JPEG, WebP, and GIF files");
  const checked = await stat(real);
  // O_NOFOLLOW and the same inode as the checked path: a symlink swapped in after the check is not followed.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw notFound();
  });
  try {
    const opened = await handle.stat();
    if (opened.ino !== checked.ino || opened.dev !== checked.dev) throw notFound();
    if (!opened.isFile())
      throw new ApiError(415, "not_an_image", "The chat shows only PNG, JPEG, WebP, and GIF files");
    if (opened.size > maxBytes) {
      throw new ApiError(
        413,
        "image_too_large",
        `The image is ${formatMib(opened.size)}; the limit is ${formatMib(maxBytes)}`,
      );
    }
    const bytes = await handle.readFile();
    if (sniff(bytes) !== mimeType)
      throw new ApiError(
        415,
        "not_an_image",
        `The file is not a ${extname(real).slice(1).toUpperCase()} image`,
      );
    return { mimeType, bytes };
  } finally {
    await handle.close();
  }
}
