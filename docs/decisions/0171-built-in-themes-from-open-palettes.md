# 0171. Built-in themes may use open palettes from other projects

- Status: Accepted
- Date: 2026-11-10

## Context

`docs/design.md` says pi-spore uses no other product's colors or branding. Ayu Dark was already an exception, with
no record. On 2026-11-10 the user asked for ten more built-in dark themes from popular editor palettes: Catppuccin
Mocha, Dracula, Everforest Dark, Gruvbox Dark, Monokai, Nord, One Dark, Primer Dark, Solarized Dark, and Tokyo
Night.

## Decision

- A built-in theme may use a published palette from another project, under the palette's own name.
- The palette must have an open license (MIT or similar), or a widely shipped precedent. Monokai (2006) has no
  license; VS Code ships it under MIT, so pi-spore ships only the 2006 values, never Monokai Pro.
- The comment above the theme's block in `themes.css` names the palette source URL and its license. It lists every
  color pi-spore changed, for example a lightness raised to meet WCAG AA.
- A theme uses no logo and claims no endorsement. A theme named after a trademark gets a neutral name: GitHub's
  dark theme is "Primer Dark", after the open Primer design system.
- pi-spore's own look (Spore Night, Spore Day, the layout, type, and shapes) stays its own.

## Consequences

- The no-branding rule in `docs/design.md` covers logos, images, fonts, and branding; theme palettes follow this ADR.
- A new open-palette theme needs only its block, its comment, and its `THEMES` entry.
