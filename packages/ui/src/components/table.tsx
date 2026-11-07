import type { ComponentProps } from "react";
import { cn } from "../cn.js";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "border-b border-line px-2 py-1.5 text-left text-[11px] font-semibold tracking-wider text-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b border-line px-2 py-2 align-top", className)} {...props} />;
}
