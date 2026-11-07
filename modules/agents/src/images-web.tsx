import { useApi } from "@pi-spore/module-api";
import type { ImageRef } from "@pi-spore/shared";
import { Button, cn, ImageViewer, Spinner } from "@pi-spore/ui";
import { ImageIcon, ImageOff } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

/** The chat whose images a message list shows: refs and linked files are read through its routes (ADR 0060). */
const ChatContext = createContext<string | undefined>(undefined);

export function ChatImages({ agentId, children }: { agentId: string; children: ReactNode }) {
  return <ChatContext.Provider value={agentId}>{children}</ChatContext.Provider>;
}

function useChatId(): string {
  const agentId = useContext(ChatContext);
  if (!agentId) throw new Error("Chat images need a ChatImages provider");
  return agentId;
}

type Loaded =
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "failed"; error: string };

/** Fetches an API path as a blob URL with the token header, and frees it when the component goes. */
function useBlobUrl(path: string): Loaded {
  const api = useApi();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let url: string | undefined;
    let current = true;
    setLoaded({ state: "loading" });
    api
      .getBlob(path)
      .then((blob) => {
        if (!current) return;
        url = URL.createObjectURL(blob);
        setLoaded({ state: "ready", url });
      })
      .catch((caught: unknown) => {
        if (current)
          setLoaded({
            state: "failed",
            error: caught instanceof Error ? caught.message : String(caught),
          });
      });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, path]);
  return loaded;
}

const BOX =
  "inline-flex h-24 w-32 items-center justify-center rounded-lg border border-line bg-panel";

/** A small image; a click opens it full size. Remote images send no referrer. */
export function Thumb({
  src,
  alt,
  caption,
  onError,
}: {
  src: string;
  alt: string;
  caption?: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open image${alt ? `: ${alt}` : ""}`}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-line bg-panel p-0 hover:border-muted"
      >
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          {...(onError ? { onError } : {})}
          className="block max-h-48 max-w-full object-contain"
        />
      </button>
      <ImageViewer
        src={src}
        alt={alt}
        open={open}
        onOpenChange={setOpen}
        {...(caption ? { caption } : {})}
      />
    </>
  );
}

// Spans, not divs: Markdown images sit inside paragraphs.
function Loading() {
  return (
    <span className={BOX} role="status" aria-label="Loading image">
      <Spinner />
    </span>
  );
}

function Unavailable({ error }: { error: string }) {
  return (
    <span className={cn(BOX, "flex-col gap-1 px-2 text-center text-xs text-muted")} title={error}>
      <ImageOff aria-hidden="true" className="size-4" />
      Image not available
    </span>
  );
}

/** An image block of a message, fetched by its ref. */
function RefImage({ block }: { block: ImageRef }) {
  const agentId = useChatId();
  const loaded = useBlobUrl(`agents/${agentId}/images/${block.ref}`);
  if (loaded.state === "loading") return <Loading />;
  if (loaded.state === "failed") return <Unavailable error={loaded.error} />;
  return (
    <Thumb src={loaded.url} alt="" caption={`${block.mimeType}, ${formatBytes(block.bytes)}`} />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The image blocks of a message or tool result as a row of thumbnails. */
export function ImageRow({ images }: { images: readonly ImageRef[] }) {
  if (images.length === 0) return null;
  // The same image may come twice in one message; its ref and how often it came before make a stable key.
  const seen = new Map<string, number>();
  const keyed = images.map((image) => {
    const count = seen.get(image.ref) ?? 0;
    seen.set(image.ref, count + 1);
    return { image, key: `${image.ref}-${count}` };
  });
  return (
    <div className="flex flex-wrap gap-2">
      {keyed.map(({ image, key }) => (
        <RefImage key={key} block={image} />
      ))}
    </div>
  );
}

/**
 * An image file the agent linked by path. The server serves it only from the workspace folder or its artifacts
 * folder; anything it refuses shows as `fallback`, the plain link.
 */
export function LinkedImage({
  path,
  alt,
  fallback,
}: {
  path: string;
  alt: string;
  fallback: ReactNode;
}) {
  const agentId = useChatId();
  const loaded = useBlobUrl(`agents/${agentId}/linked-image?path=${encodeURIComponent(path)}`);
  if (loaded.state === "loading") return <Loading />;
  if (loaded.state === "failed") return <>{fallback}</>;
  return (
    <span className="my-1 inline-flex max-w-full flex-col items-start gap-1">
      <Thumb src={loaded.url} alt={alt} caption={path} />
      <span className="truncate font-mono text-xs text-muted" title={path}>
        {alt && alt !== path ? `${alt} · ${path}` : path}
      </span>
    </span>
  );
}

/**
 * An image on another site. It loads only after a click, because loading it tells that site the user read the chat
 * (ADR 0061). No referrer is sent.
 */
export function RemoteImage({ url, host, alt }: { url: string; host: string; alt: string }) {
  const [load, setLoad] = useState(false);
  const [failed, setFailed] = useState(false);
  if (load && !failed) {
    return (
      <span className="my-1 inline-flex max-w-full flex-col items-start gap-1">
        <Thumb src={url} alt={alt} caption={host} onError={() => setFailed(true)} />
        <span className="truncate text-xs text-muted">{host}</span>
      </span>
    );
  }
  return (
    <span className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 align-middle text-sm">
      <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 truncate">
        {alt || "Image"} <span className="text-muted">from {host}</span>
      </span>
      {failed ? (
        <span className="text-xs text-fail">Did not load</span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setLoad(true)}
          title={`Loading tells ${host} that you opened this chat`}
        >
          Load
        </Button>
      )}
    </span>
  );
}
