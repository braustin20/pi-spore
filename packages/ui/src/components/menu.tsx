import { DropdownMenu } from "radix-ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { Tooltip } from "./tooltip.js";

/**
 * A dropdown menu. The trigger must be one element that takes a ref, such as a `Button`.
 * With `tooltip`, the trigger shows it on hover, and the menu hides it while open so it does not cover the items.
 */
export function Menu({
  trigger,
  tooltip,
  align = "start",
  children,
}: {
  trigger: ReactElement;
  tooltip?: ReactNode;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerEl = <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      {tooltip === undefined ? (
        triggerEl
      ) : (
        <Tooltip label={tooltip} side="bottom" hidden={open}>
          {/* A disabled button gets no pointer events, so the span takes the hover. */}
          <span className="inline-flex">{triggerEl}</span>
        </Tooltip>
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-1rem)] min-w-56 overflow-y-auto rounded-xl border border-line bg-panel p-1 text-sm text-fg"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// Phones get 44 px rows so each item is a full touch target.
const ITEM =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-inherit no-underline outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-raised max-md:min-h-11";

/** One menu entry. With `href` it is a real link, so it opens in a new tab and shows its address. */
export function MenuItem({
  children,
  onSelect,
  disabled,
  href,
  current,
  title,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  href?: string;
  /** Marks the link to the page that shows now. */
  current?: boolean;
  title?: string;
}) {
  if (href !== undefined) {
    return (
      <DropdownMenu.Item asChild className={ITEM}>
        <a href={href} title={title} aria-current={current ? "page" : undefined}>
          {children}
        </a>
      </DropdownMenu.Item>
    );
  }
  return (
    <DropdownMenu.Item
      className={ITEM}
      title={title}
      disabled={disabled}
      {...(onSelect ? { onSelect } : {})}
    >
      {children}
    </DropdownMenu.Item>
  );
}

/** Text in a menu that is not a choice. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 py-1.5 font-mono text-xs text-muted">
      {children}
    </DropdownMenu.Label>
  );
}
