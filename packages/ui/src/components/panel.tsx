import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.js";
import { SectionLabel } from "./section-label.js";

/** A bordered box on the panel color. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("rounded-xl border border-line bg-panel p-4", className)} {...props} />
  );
}

/** A panel's title row: a section label on the left, tools on the right. */
export function PanelHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-2", className)}>
      <SectionLabel marker>{title}</SectionLabel>
      {children && <div className="flex items-center gap-1.5">{children}</div>}
    </div>
  );
}
