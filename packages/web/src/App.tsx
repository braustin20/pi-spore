import { useApi, type WebPage } from "@pi-spore/module-api";
import { cn, EmptyState, Page, ThemeMenu, Tooltip, TooltipProvider } from "@pi-spore/ui";
import { MapPinOff } from "lucide-react";
import { useEffect, useState } from "react";
import { findPage, railActive, useHashPath } from "./router.js";

const HEALTH_EVERY_MS = 30_000;

/** A dot in the top bar: green while the server answers /health, red when it does not. */
function ServerStatus() {
  const api = useApi();
  const [ok, setOk] = useState<boolean | undefined>();
  useEffect(() => {
    let current = true;
    const check = () =>
      api.get("health").then(
        () => current && setOk(true),
        () => current && setOk(false),
      );
    void check();
    const timer = setInterval(check, HEALTH_EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [api]);
  const label =
    ok === undefined ? "Checking the server" : ok ? "Server connected" : "Server not reachable";
  return (
    <span role="status" title={label} className="flex items-center gap-1.5 px-2 text-xs text-muted">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          ok === undefined ? "bg-muted" : ok ? "bg-ok" : "bg-fail",
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Rail({ pages, path }: { pages: readonly WebPage[]; path: string }) {
  const items = pages
    .filter((page) => page.rail)
    .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0));
  return (
    <nav
      aria-label="Main"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2"
    >
      {items.map((page) => {
        const Icon = page.rail?.icon;
        const active = railActive(page.path, path);
        return (
          <Tooltip key={page.path} label={page.title}>
            <a
              href={`#${page.path}`}
              aria-label={page.title}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex size-10 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg",
                active &&
                  "bg-raised text-accent-strong before:absolute before:inset-y-2 before:-left-2 before:w-0.5 before:rounded-full before:bg-accent hover:text-accent-strong",
              )}
            >
              {Icon && <Icon className="size-5" />}
            </a>
          </Tooltip>
        );
      })}
    </nav>
  );
}

export function App({ pages }: { pages: readonly WebPage[] }) {
  const path = useHashPath();
  const found = findPage(pages, path);
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-2 pl-4">
          <a href="#/" className="flex items-center gap-2 font-semibold text-fg no-underline">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-accent" />
            pi-spore
          </a>
          <div className="flex-1" />
          <ThemeMenu />
          <ServerStatus />
        </header>
        <div className="flex min-h-0 flex-1">
          <Rail pages={pages} path={path} />
          <main className="min-w-0 flex-1">
            {found ? (
              <found.page.component params={found.params} />
            ) : (
              <Page>
                <EmptyState icon={MapPinOff} title="No page here">
                  Nothing lives at <code>{path}</code>. Pick a page in the rail.
                </EmptyState>
              </Page>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
