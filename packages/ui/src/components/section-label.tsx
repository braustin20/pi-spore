import type { ComponentProps } from "react";
import { cn } from "../cn.js";

/** A small uppercase label over a group, optionally after an accent square. */
export function SectionLabel({
  marker = false,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { marker?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase",
        className,
      )}
      {...props}
    >
      {marker && <span aria-hidden="true" className="size-1.5 rounded-xs bg-accent" />}
      {children}
    </div>
  );
}
