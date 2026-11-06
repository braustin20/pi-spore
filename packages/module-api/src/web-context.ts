import { createContext, useContext } from "react";
import type { ApiClient } from "./modules.js";

/** The shell provides the API client here, so module pages can be plain top-level components. */
export const ApiContext = createContext<ApiClient | undefined>(undefined);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi() was called outside the pi-spore web shell");
  return api;
}
