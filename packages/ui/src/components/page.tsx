import type { ReactNode } from "react";
import { cn } from "../cn.js";

/** A full page inside the shell: it scrolls on its own and keeps a readable width. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex max-w-5xl flex-col gap-5 px-8 py-6 max-md:px-4 max-md:py-4",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** A page's title row, with an optional line above it (such as a back link) and actions on the right. */
export function PageHeader({
  title,
  above,
  children,
}: {
  title: ReactNode;
  above?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-md:basis-full">
        {above && <div className="mb-1 text-sm text-muted">{above}</div>}
        <h1 className="m-0 truncate text-xl font-semibold">{title}</h1>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}
