import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.js";

const control =
  "rounded-lg border border-line bg-raised text-fg text-sm placeholder:text-muted disabled:cursor-default disabled:opacity-50";

/** A label above its control. */
export function Field({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className={cn("flex flex-col gap-1 text-xs text-muted", className)}>
      {label}
      {children}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, "h-8 px-2.5", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "resize-y px-2.5 py-2", className)} {...props} />;
}

/** A native select with the input look. Native, so long lists and keyboard use work as the platform does. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select className={cn(control, "h-8 w-full appearance-none pr-7 pl-2.5")} {...props} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted"
      />
    </span>
  );
}

/** A checkbox with its label to the right. */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-sm text-muted", className)}>
      <input type="checkbox" className="size-3.5 accent-accent" {...props} />
      {label}
    </label>
  );
}
