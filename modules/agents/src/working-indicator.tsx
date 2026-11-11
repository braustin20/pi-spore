import { SporeLogo } from "@pi-spore/ui";
import { useEffect, useState } from "react";

/** The animated spore logo with what the agent is doing and how long it has been at it. */
export function WorkingIndicator({ label }: { label: string | undefined }) {
  const [since, setSince] = useState<number | undefined>();
  const [, tick] = useState(0);
  const working = label !== undefined;
  useEffect(() => {
    if (!working) {
      setSince(undefined);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [working]);
  if (!working) return null;
  const seconds = since === undefined ? 0 : Math.floor((Date.now() - since) / 1_000);
  return (
    <div
      className="flex items-center gap-2 px-1 pb-2 text-sm text-accent-strong"
      role="status"
      aria-live="polite"
    >
      <SporeLogo working className="size-4" />
      <span>{label}</span>
      <span className="font-mono text-xs text-muted">{seconds}s</span>
    </div>
  );
}
