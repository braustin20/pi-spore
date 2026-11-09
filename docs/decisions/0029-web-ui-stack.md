# 0029. Web UI: one shared `@pi-spore/ui` package with Tailwind, Radix, and shadcn-style components

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.1, R1.5, R5

## Context

The design (docs/design.md) asks for swappable themes, a fixed set of components, and a three-pane shell. Pages
come from many web modules, and a module may not import the web app (packages/web). The first pages used plain
class names in one placeholder stylesheet. The user chose React with Tailwind and shadcn/Radix.

## Decision

- `packages/ui` (`@pi-spore/ui`) holds the components, the stylesheet, and the themes. Web modules and the shell
  import it. It has no Node imports and no API calls.
- Styling is Tailwind CSS v4 through `@tailwindcss/vite`. The default palette is removed; the only colors are the
  role tokens of docs/design.md (`bg-panel`, `text-fg`, `border-line`, `bg-accent`, ...). Biome's
  `noTailwindRawColors` rule checks class strings. Its `useTailwindSortedClasses` rule is not used: in Biome
  2.6.6 its fix drops the space in `${streaming ? " streaming" : ""}`.
- Components follow the shadcn pattern: small source files in the repo, written against our tokens, using Radix
  primitives (`radix-ui`) for tabs, menus, tooltips, and collapsibles, `class-variance-authority` for variants,
  and `cn()` (clsx with tailwind-merge) to join classes. The shadcn CLI is not used; its files assume a different
  token set and import alias.
- Icons come from `lucide-react`. Inter and JetBrains Mono come from `@fontsource-variable/*`. Nothing loads from
  a CDN, so the app works offline.
- A theme is one `[data-theme]` block in `packages/ui/src/themes.css` plus one entry in `themes.ts`. A unit test
  computes WCAG contrast from the CSS values.

## Consequences

- Modules get typed components and the same markup and focus behavior everywhere.
- Every web module depends on `@pi-spore/ui` and lists it in its tsconfig references.
- Tailwind scans `packages/web/src`, `packages/ui/src`, and `modules/`. A new folder with class names must be
  added to `packages/web/src/app.css`.
- Native `<select>` stays for model lists and form choices: long lists and keyboard use work as the platform does.
- Confirmations use the styled `useConfirm()` dialog from `@pi-spore/ui`, not `window.confirm`.
