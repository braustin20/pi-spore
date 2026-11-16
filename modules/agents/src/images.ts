import { createHash } from "node:crypto";
import { extname, isAbsolute, resolve } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import { readFileInside } from "@pi-spore/module-api/node";
import {
  IMAGE_TYPES,
  type ImageRef,
  type ImageType,
  imageTypeOfPath,
  type PromptImage,
  sniffImage,
} from "@pi-spore/shared";

const MIB = 1024 * 1024;

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
    if (sniffImage(bytes) !== claimed) {
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

export function servableType(mimeType: string): ImageType {
  if (!isImageType(mimeType))
    throw new ApiError(415, "unsupported_image", `The chat does not show ${mimeType} images`);
  return mimeType;
}

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
  const notAnImage = () =>
    new ApiError(415, "not_an_image", "The chat shows only PNG, JPEG, WebP, and GIF files");
  const { real, bytes } = await readFileInside(
    isAbsolute(path) ? path : resolve(base, path),
    roots,
    maxBytes,
    // The real name counts, so `shot.png` linking to `.env` is refused.
    (real) => {
      if (!imageTypeOfPath(real)) throw notAnImage();
    },
  );
  const mimeType = imageTypeOfPath(real);
  if (!mimeType || sniffImage(bytes) !== mimeType)
    throw new ApiError(
      415,
      "not_an_image",
      `The file is not a ${extname(real).slice(1).toUpperCase()} image`,
    );
  return { mimeType, bytes };
}
