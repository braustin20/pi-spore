import type { ComponentProps } from "react";
import { cn } from "../cn.js";

/** A link row in a list. The selected row gets the raised background and a 2 px accent bar on the left. */
export function ListRow({
  selected = false,
  className,
  ...props
}: ComponentProps<"a"> & { selected?: boolean }) {
  return (
    <a
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative block rounded-lg px-3 py-2 text-fg no-underline hover:bg-raised/60",
        selected &&
          "bg-raised before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent hover:bg-raised",
        className,
      )}
      {...props}
    />
  );
}
