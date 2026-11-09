import { AlertDialog } from "radix-ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "./button.js";

export type ConfirmOptions = {
  title?: string;
  /** The question. Blank lines in it show as paragraph breaks. */
  message: string;
  /** Default "Confirm". */
  confirmLabel?: string;
  /** "danger" colors the confirm button for destructive actions. */
  tone?: "danger";
};

/** Resolves true when the user confirms, false on Cancel, Escape, or when a newer question replaces it. */
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type Pending = { options: ConfirmOptions; resolve: (answer: boolean) => void };

/**
 * A themed, non-blocking replacement for the browser's confirm box (ADR 0029). Render `dialog` once in the component that calls `confirm`.
 * Radix puts focus on Cancel first and closes on Escape.
 */
export function useConfirm(): { confirm: Confirm; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending>();
  const current = useRef<Pending>(undefined);
  const opener = useRef<HTMLElement | null>(null);

  const settle = useCallback((answer: boolean) => {
    current.current?.resolve(answer);
    current.current = undefined;
    setPending(undefined);
  }, []);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        // Radix has no trigger here, so it cannot give focus back by itself.
        if (!current.current) opener.current = document.activeElement as HTMLElement | null;
        current.current = { options, resolve };
        setPending(current.current);
      }),
    [],
  );

  const options = pending?.options;
  const dialog = (
    <AlertDialog.Root open={pending !== undefined} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-bg/85" />
        <AlertDialog.Content
          onCloseAutoFocus={() => opener.current?.isConnected && opener.current.focus()}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-3rem)] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel p-4 focus-visible:outline-none"
        >
          <AlertDialog.Title className="m-0 shrink-0 text-sm font-medium">
            {options?.title ?? "Are you sure?"}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 mb-4 min-h-0 overflow-y-auto text-sm whitespace-pre-line text-muted [overflow-wrap:anywhere]">
            {options?.message}
          </AlertDialog.Description>
          <div className="flex shrink-0 justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant={options?.tone === "danger" ? "danger" : "primary"}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return { confirm, dialog };
}
