import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button.js";

/**
 * A full-size image over the page. Escape, the close button, or a click outside closes it. `src` is a URL the page
 * already holds, such as a blob URL.
 */
export function ImageViewer({
  src,
  alt,
  open,
  onOpenChange,
  caption,
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caption?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/85" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 p-6 focus-visible:outline-none">
          <Dialog.Title className="sr-only">{alt || "Image"}</Dialog.Title>
          <Dialog.Description className="sr-only">
            The image at full size. Press Escape to close.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Close image"
              className="absolute top-4 right-4"
            >
              <X />
            </Button>
          </Dialog.Close>
          <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            className="max-h-[calc(100vh-6rem)] max-w-full rounded-lg border border-line bg-panel object-contain"
          />
          {caption && <div className="max-w-full truncate text-sm text-muted">{caption}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
