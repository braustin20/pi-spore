import type { ComponentProps } from "react";
import { cn } from "../cn.js";
import type { Tone } from "./chip.js";

const DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent-strong",
  ok: "bg-ok",
  fail: "bg-fail",
  warn: "bg-warn",
  run: "bg-run animate-pulse",
};

const TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  accent: "text-accent-strong",
  ok: "text-ok",
  fail: "text-fail",
  warn: "text-warn",
  run: "text-run",
};

/** One line of live state, such as "Thinking" or "Stopped", after a colored dot. */
export function StatusLine({
  tone = "neutral",
  className,
  children,
  ...props
}: ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", TEXT[tone], className)}
      {...props}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      <span className="truncate">{children}</span>
    </span>
  );
}
