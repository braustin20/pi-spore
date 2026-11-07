import { cn } from "../cn.js";

/** Added and deleted line counts, such as `+12 -3`. */
export function DiffCount({
  added,
  deleted,
  className,
}: {
  added: number;
  deleted: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex gap-1.5 font-mono text-xs", className)}>
      <span className="text-diff-add">+{added}</span>
      <span className="text-diff-del">-{deleted}</span>
    </span>
  );
}
