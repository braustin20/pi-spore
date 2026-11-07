import { useCallback, useState } from "react";

/** A stored "1" or "0" as a boolean; anything else (nothing stored, or a value from an old version) gives `fallback`. */
export function readFlag(
  storage: Pick<Storage, "getItem">,
  key: string,
  fallback: boolean,
): boolean {
  const stored = storage.getItem(key);
  return stored === "1" ? true : stored === "0" ? false : fallback;
}

/** A boolean UI choice, such as a collapsed column, that the browser remembers. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(localStorage, key, fallback));
  const set = useCallback(
    (next: boolean) => {
      localStorage.setItem(key, next ? "1" : "0");
      setValue(next);
    },
    [key],
  );
  return [value, set];
}
