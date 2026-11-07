import type { ComponentType, ReactNode } from "react";
import { cn } from "../cn.js";

/** What a view shows when it has nothing yet: an icon, a title, a line of help, and an optional action. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon && <Icon className="mb-1 size-8 text-muted" aria-hidden="true" />}
      <div className="font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
