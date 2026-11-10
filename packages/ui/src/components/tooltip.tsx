import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type ReactElement, type ReactNode, useState } from "react";

/** Wrap the app once, so tooltips share one open delay. */
export const TooltipProvider = TooltipPrimitive.Provider;

/** Shows `label` next to the child on hover and keyboard focus. The child still needs its own aria-label. */
export function Tooltip({
  label,
  side = "right",
  hidden = false,
  children,
}: {
  label: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Keeps the tooltip closed, such as while the menu it labels is open. */
  hidden?: boolean;
  children: ReactElement;
}) {
  // Always controlled, so `hidden` never switches the root between controlled and uncontrolled.
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Root open={open && !hidden} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
