import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

const STYLE = {
  info: { box: "border-line bg-raised text-muted", Icon: Info },
  warn: { box: "border-warn/40 bg-warn/10 text-warn", Icon: TriangleAlert },
  fail: { box: "border-fail/40 bg-fail/10 text-fail", Icon: CircleAlert },
} as const;

/** A message box for errors, warnings, and notes. Errors are announced to screen readers. */
export function Notice({
  tone = "info",
  className,
  children,
  ...props
}: ComponentProps<"div"> & { tone?: keyof typeof STYLE }) {
  const { box, Icon } = STYLE[tone];
  return (
    <div
      role={tone === "fail" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm [overflow-wrap:anywhere]",
        box,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
