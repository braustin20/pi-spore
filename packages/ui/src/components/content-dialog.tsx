import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useRef } from "react";
import { cn } from "../cn.js";
import { Button } from "./button.js";

/**
 * A titled panel over the page. Escape, the close button, or a click outside closes it. `full` fills the screen and
 * leaves the scrolling to its child.
 */
export function ContentDialog({
  open,
  onOpenChange,
  title,
  size = "default",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  size?: "default" | "full";
  children: ReactNode;
}) {
  const full = size === "full";
  // A drag from the panel that ends on the inset sends its click to the inset, so only a press that starts there
  // closes.
  const pressedInset = useRef(false);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/85" />
        <Dialog.Content
          className={cn(
            "fixed inset-0 z-50 flex items-center justify-center focus-visible:outline-none",
            full ? "p-3" : "p-6",
          )}
          // The inset around the panel is inside Dialog.Content, so Radix does not count a click there as outside.
          onPointerDown={(event) => {
            pressedInset.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (pressedInset.current && event.target === event.currentTarget) onOpenChange(false);
          }}
          // Radix sees Escape before the focused field does. A field may use Escape itself, as a comment form does
          // to cancel, so Escape there does not close the dialog.
          onEscapeKeyDown={(event) => {
            const target = event.target;
            if (
              target instanceof HTMLElement &&
              (target.matches("input, textarea, select") || target.isContentEditable)
            )
              event.preventDefault();
          }}
        >
          <div
            className={cn(
              "flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-panel",
              full ? "h-full" : "max-w-4xl",
            )}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <Dialog.Title className="m-0 min-w-0 flex-1 truncate font-mono text-xs font-normal">
                {title}
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Close">
                  <X />
                </Button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Press Escape to close.</Dialog.Description>
            <div className={full ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-auto"}>
              {children}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
