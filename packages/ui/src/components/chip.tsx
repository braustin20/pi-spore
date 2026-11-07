import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

const chipVariants = cva(
  "inline-block max-w-full shrink-0 truncate rounded-md border px-1.5 py-px align-middle text-xs leading-4",
  {
    variants: {
      tone: {
        neutral: "border-line bg-raised text-muted",
        accent: "border-accent/50 bg-accent/10 text-accent-strong",
        ok: "border-ok/40 bg-ok/10 text-ok",
        fail: "border-fail/40 bg-fail/10 text-fail",
        warn: "border-warn/40 bg-warn/10 text-warn",
        run: "border-run/40 bg-run/10 text-run",
      },
      mono: { true: "font-mono", false: "" },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
);

export type Tone = "neutral" | "accent" | "ok" | "fail" | "warn" | "run";

/** A small label: a state, a branch, a count. Use `mono` for ids, branches, and counts. */
export function Chip({
  className,
  tone,
  mono,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof chipVariants>) {
  return <span className={cn(chipVariants({ tone, mono }), className)} {...props} />;
}
