import { X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";

export interface Toast {
  title: string;
  /** May be empty. */
  body: string;
  tone: "warn" | "fail" | "ok";
  /** Where the Open link goes. */
  href: string;
}

interface Shown extends Toast {
  id: number;
}

const MAX_SHOWN = 3;
const SHOW_MS = 8000;

const ACCENT = {
  warn: "border-l-warn",
  fail: "border-l-fail",
  ok: "border-l-ok",
} as const;

let nextId = 1;
let shown: readonly Shown[] = [];
const listeners = new Set<() => void>();

function setShown(next: readonly Shown[]): void {
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Pushes a toast from any module. It shows only while a `Toaster` is mounted; the oldest of more than 3 is dropped. */
export function showToast(toast: Toast): void {
  setShown([...shown, { ...toast, id: nextId++ }].slice(-MAX_SHOWN));
}

/** Mount once near the app root. It renders what `showToast` pushed; a toast closes after 8 seconds unless hovered. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, () => shown);
  return (
    <ToastPrimitive.Provider duration={SHOW_MS}>
      {toasts.map((toast) => (
        <ToastPrimitive.Root
          key={toast.id}
          onOpenChange={(open) => {
            if (!open) setShown(shown.filter((each) => each.id !== toast.id));
          }}
          className={`flex items-start gap-2 rounded-lg border border-l-4 border-line bg-raised px-3 py-2 text-sm text-fg ${ACCENT[toast.tone]}`}
        >
          <div className="min-w-0 flex-1">
            <ToastPrimitive.Title className="font-medium [overflow-wrap:anywhere]">
              {toast.title}
            </ToastPrimitive.Title>
            {toast.body && (
              <ToastPrimitive.Description className="mt-0.5 line-clamp-4 text-muted [overflow-wrap:anywhere]">
                {toast.body}
              </ToastPrimitive.Description>
            )}
            <ToastPrimitive.Action asChild altText="Open">
              <a href={toast.href} className="mt-1 inline-block text-accent-strong hover:underline">
                Open
              </a>
            </ToastPrimitive.Action>
          </div>
          <ToastPrimitive.Close aria-label="Close" className="text-muted hover:text-fg">
            <X aria-hidden="true" className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-50 m-0 flex w-96 max-w-[calc(100vw-2rem)] list-none flex-col gap-2 p-0" />
    </ToastPrimitive.Provider>
  );
}
