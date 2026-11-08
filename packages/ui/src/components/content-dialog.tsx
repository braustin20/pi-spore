import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button.js";

/** A titled panel over the page. Escape, the close button, or a click outside closes it. */
export function ContentDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/85" />
        <Dialog.Content className="fixed inset-0 z-50 flex items-center justify-center p-6 focus-visible:outline-none">
          <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-line bg-panel">
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
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
