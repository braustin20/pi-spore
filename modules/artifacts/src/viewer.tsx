import { useApi } from "@pi-spore/module-api";
import { Notice, Spinner } from "@pi-spore/ui";
import { useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Kind = "markdown" | "image" | "html" | "text";

function kindOf(name: string): Kind {
  const lower = name.toLowerCase();
  if (/\.(md|markdown)$/.test(lower)) return "markdown";
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  if (/\.html?$/.test(lower)) return "html";
  return "text";
}

type Loaded =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "ready"; text: string }
  | { state: "image"; url: string };

/** Fetches an API path with the token header: text for most kinds, a blob URL (freed on unmount) for an image. */
function useFile(source: string, image: boolean): Loaded {
  const api = useApi();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let url: string | undefined;
    let current = true;
    setLoaded({ state: "loading" });
    api
      .getBlob(source)
      .then(async (blob) => {
        if (image) {
          url = URL.createObjectURL(blob);
          if (current) setLoaded({ state: "image", url });
          return;
        }
        const text = await blob.text();
        if (current) setLoaded({ state: "ready", text });
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
  }, [api, source, image]);
  return loaded;
}

/** Images in a viewed file never load (ADR 0061): a remote one would tell its site the user read the file. */
const MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    return <a href={url}>{alt || url}</a>;
  },
};

/**
 * One artifact or linked file, shown by the extension of `name`. `source` is the API path of its bytes. HTML goes into
 * a sandbox with no permissions, so its scripts do not run and it cannot reach the app.
 */
export function ArtifactView({ source, name }: { source: string; name: string }) {
  const kind = kindOf(name);
  const loaded = useFile(source, kind === "image");
  if (loaded.state === "loading") {
    return (
      <div className="flex justify-center p-6" role="status" aria-label="Loading">
        <Spinner />
      </div>
    );
  }
  if (loaded.state === "failed") {
    return (
      <Notice tone="fail" className="m-3">
        {loaded.error}
      </Notice>
    );
  }
  if (loaded.state === "image") {
    return (
      <div className="p-3">
        <img src={loaded.url} alt={name} className="max-w-full rounded-lg border border-line" />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <div className="md p-3">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {loaded.text}
        </Markdown>
      </div>
    );
  }
  if (kind === "html") {
    return (
      <iframe
        sandbox=""
        srcDoc={loaded.text}
        title={name}
        // biome-ignore lint/nursery/noTailwindRawColors: a page written for a white browser canvas, whatever the theme
        className="h-full min-h-96 w-full border-0 bg-white"
      />
    );
  }
  return (
    <pre className="m-0 p-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-fg">
      {loaded.text}
    </pre>
  );
}
