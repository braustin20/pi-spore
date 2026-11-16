import { createContext, useContext, useEffect, useState } from "react";
import type { ApiClient } from "./modules.js";

/** The shell provides the API client here, so module pages can be plain top-level components. */
export const ApiContext = createContext<ApiClient | undefined>(undefined);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi() was called outside the pi-spore web shell");
  return api;
}

type Loaded =
  | { state: "loading" }
  | { state: "ready"; url: string; bytes: number }
  | { state: "failed"; error: string };

/** Fetches an API path as a blob URL with the token header, and frees it when the component goes. */
export function useBlobUrl(path: string): Loaded {
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
        setLoaded({ state: "ready", url, bytes: blob.size });
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
