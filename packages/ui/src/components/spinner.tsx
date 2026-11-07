import { cn } from "../cn.js";

/** A small spinning ring. With reduced motion it stands still. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent",
        className,
      )}
    />
  );
}
