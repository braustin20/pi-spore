import { ChevronRight } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../cn.js";

/** A titled section that folds open and closed, such as a module panel in the right column. */
export function CollapsibleSection({
  title,
  defaultOpen = true,
  className,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("border-b border-line", className)}>
      <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-1.5 px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-fg">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
        />
        {title}
      </Collapsible.Trigger>
      <Collapsible.Content className="px-4 pb-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
