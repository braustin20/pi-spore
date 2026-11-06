import type { WebPage } from "@pi-spore/module-api";
import { findPage, useHashPath } from "./router.js";

export function App({ pages }: { pages: readonly WebPage[] }) {
  const path = useHashPath();
  const found = findPage(pages, path);
  const nav = pages
    .filter((page) => page.navOrder !== undefined)
    .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0));

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          pi-spore
        </a>
        <nav>
          {nav.map((page) => (
            <a
              key={page.path}
              href={`#${page.path}`}
              className={path === page.path ? "active" : undefined}
            >
              {page.title}
            </a>
          ))}
        </nav>
      </header>
      <main className="content">
        {found ? (
          <found.page.component params={found.params} />
        ) : (
          <p>
            No page at <code>{path}</code>.
          </p>
        )}
      </main>
    </div>
  );
}
