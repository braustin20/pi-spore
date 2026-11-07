import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must know the role colors, or it treats `text-fg` and `text-sm` as the same group.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        "bg",
        "panel",
        "raised",
        "line",
        "fg",
        "muted",
        "accent",
        "accent-strong",
        "on-accent",
        "ok",
        "fail",
        "warn",
        "run",
        "diff-add",
        "diff-del",
      ],
    },
  },
});

/** Joins class names; a later Tailwind class wins over an earlier one of the same kind. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
