import { SporeLogo } from "@pi-spore/ui";
import { useEffect, useState } from "react";

/**
 * The animated spore logo with what the agent is doing and how long it has been at it. `since` is when the agent
 * reached its status, so the count survives a reload and a re-mount; it comes from the server.
 */
export function WorkingIndicator({ label, since }: { label: string | undefined; since: number }) {
  const [, tick] = useState(0);
  const working = label !== undefined;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [working]);
  if (!working) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1_000));
  const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <div
      className="flex items-center gap-2 px-1 pb-2 text-sm text-accent-strong"
      role="status"
      aria-live="polite"
    >
      <SporeLogo working className="size-4" />
      <span>{label}</span>
      <span className="font-mono text-xs text-muted">{time}</span>
    </div>
  );
}
