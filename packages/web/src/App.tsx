import { useApi, type WebPage } from "@pi-spore/module-api";
import {
  cn,
  EmptyState,
  Page,
  SporeLogo,
  ThemeMenu,
  Toaster,
  Tooltip,
  TooltipProvider,
  usePhone,
} from "@pi-spore/ui";
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

const noBadge = () => 0;

/** Follows the visual viewport on phones. See the phone rules in packages/ui/src/styles.css. */
function useKeyboardInset() {
  const phone = usePhone();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!phone || !viewport) return;
    // iOS Safari does not shrink the layout or dvh for the on-screen keyboard, so the composer would sit under it.
    const root = document.documentElement.style;
    const update = () => {
      root.setProperty("--app-height", `${viewport.height}px`);
      root.setProperty("--app-top", `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.removeProperty("--app-height");
      root.removeProperty("--app-top");
    };
  }, [phone]);
}

/** `inHeader` is the phone row in the top bar: bigger touch targets, and the lit mark sits under the icon. */
function RailLink({
  page,
  path,
  inHeader = false,
}: {
  page: WebPage;
  path: string;
  inHeader?: boolean;
}) {
  const Icon = page.rail?.icon;
  // The page list never changes after load, so each link always calls the same hook.
  const count = (page.rail?.useBadge ?? noBadge)();
  const active = railActive(page.path, path);
  const label = count > 0 ? `${page.title} (${count})` : page.title;
  return (
    <Tooltip label={label}>
      <a
        href={`#${page.path}`}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg",
          inHeader ? "size-11 shrink-0" : "size-10",
          active &&
            "bg-raised text-accent-strong before:absolute before:rounded-full before:bg-accent hover:text-accent-strong",
          active &&
            (inHeader
              ? "before:inset-x-2 before:bottom-0 before:h-0.5"
              : "before:inset-y-2 before:-left-2 before:w-0.5"),
        )}
      >
        {Icon && <Icon className="size-5" />}
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-4 font-semibold text-on-accent"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </a>
    </Tooltip>
  );
}

function railItems(pages: readonly WebPage[]): WebPage[] {
  return pages
    .filter((page) => page.rail)
    .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0));
}

/** The rail on wide screens. Phones get the same links in the top bar instead. */
function Rail({ items, path }: { items: readonly WebPage[]; path: string }) {
  return (
    <nav
      aria-label="Main"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2 max-md:hidden"
    >
      {items.map((page) => (
        <RailLink key={page.path} page={page} path={path} />
      ))}
    </nav>
  );
}

export function App({ pages }: { pages: readonly WebPage[] }) {
  const path = useHashPath();
  const found = findPage(pages, path);
  const items = railItems(pages);
  useKeyboardInset();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header
          data-hide-while-typing
          className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-2 pl-4 max-md:h-12 max-md:gap-1 max-md:pl-1"
        >
          {/* Phones: the Home link in the row below takes the logo's place, so all links fit. */}
          <a
            href="#/"
            className="flex items-center gap-2 font-semibold text-fg no-underline max-md:hidden"
          >
            <SporeLogo className="size-5 text-accent" />
            pi-spore
          </a>
          <nav
            aria-label="Main"
            className="relative flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] md:hidden"
          >
            {items.map((page) => (
              <RailLink key={page.path} page={page} path={path} inHeader />
            ))}
          </nav>
          <div className="flex-1 max-md:hidden" />
          <ThemeMenu />
          <ServerStatus />
        </header>
        <div className="flex min-h-0 flex-1">
          <Rail items={items} path={path} />
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
      <Toaster />
    </TooltipProvider>
  );
}
