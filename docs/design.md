# Visual design direction

- Date: 2026-11-06
- Status: built in the styling slice (ADR 0029). Sections marked "later" describe screens that come with their
  modules.
- pi-spore uses its own name and default palette. It uses no other product's logos, images, fonts, or branding.
  Built-in themes may use open palettes from other projects, with credit ([ADR 0171](decisions/0171-built-in-themes-from-open-palettes.md)).

## Feel

Dark, calm, and dense, in the style of current agent workbenches. A near-black background with a slight violet
tint, gray-violet panels separated by thin borders, and one accent color for the primary action, the selection, and
live state. Information is packed into small chips and one-line status rows, not large cards.

## Themes

Colors are swappable. The look of the components (shapes, spacing, type, layout) stays fixed; the palette changes.

- Components use only role tokens: `--bg`, `--panel`, `--raised`, `--line`, `--text`, `--text-muted`,
  `--accent`, `--accent-strong`, `--on-accent`, `--ok`, `--fail`, `--warn`, `--run`, `--diff-add`, `--diff-del`.
  No component uses a raw color.
- A theme is one set of values for those tokens, as a `[data-theme="<id>"]` block of CSS variables in
  `packages/ui/src/themes.css`, written as `hsl(h s% l%)`.
- In Tailwind classes the tokens are colors with the same names, except `--text` is `fg` and `--text-muted` is
  `muted`: `bg-panel`, `text-fg`, `text-muted`, `border-line`, `bg-accent text-on-accent`. The default Tailwind
  palette is removed, so a raw color class does not exist.
- A theme menu (top bar and Settings) lists the themes with a color preview and applies the choice at once,
  without a reload.
- v1 keeps the choice in the browser (`localStorage`). When the settings module lands, it moves to
  `~/.pi-spore/settings.json`, so the CLI and every browser share it.
- Built-in themes, in menu order (dark first, then light): **Spore Night** (the default, below), **Ayu Dark**
  (matches the user's Pi theme), **Catppuccin Mocha**, **Dracula**, **Everforest Dark**, **Gruvbox Dark**,
  **Monokai**, **Nord**, **One Dark**, **Primer Dark**, **Solarized Dark**, **Tokyo Night**, and **Spore Day**
  (light). Adding a theme means adding one token block in `themes.css` and one entry in `themes.ts`. A theme from
  another project's palette names its source and license in a comment above its block, and lists each color
  changed to meet AA (ADR 0171).
- The theme menu scrolls when it is taller than the screen.
- Every theme must meet WCAG AA (4.5:1) for text on `--bg`, `--panel`, and `--accent`. The test
  (`packages/ui/src/themes.test.ts`) checks every text and status token on `--bg`, `--panel`, and `--raised`, and
  `--on-accent` on `--accent`, for each built-in theme. It also checks that each block sets every token.

## Default theme: Spore Night

pi-spore's own values, as HSL.

| Role token | HSL | Use |
|---|---|---|
| `--bg` | 255 16% 9% | App background |
| `--panel` | 255 14% 12% | Panels, sidebars |
| `--raised` | 254 12% 16% | Raised rows, inputs, selection |
| `--line` | 254 12% 22% | Borders, dividers |
| `--text` | 250 10% 88% | Body text |
| `--text-muted` | 250 6% 60% | Secondary text, icons |
| `--accent` | 258 90% 62% | Primary buttons, selection bar |
| `--accent-strong` | 258 95% 80% | Links, active nav, live-state text |
| `--on-accent` | 0 0% 100% | Text on `--accent` |
| `--ok` | 145 55% 55% | Passed gates, merged |
| `--fail` | 355 75% 66% | Failed gates, blocking findings |
| `--warn` | 38 90% 62% | Waiting for you, approvals, warnings |
| `--run` | 210 85% 66% | Running |
| `--diff-add` | 145 55% 55% | `+` line counts |
| `--diff-del` | 355 75% 66% | `-` line counts |

Status colors are kept apart from the accent, so "selected" never reads as "ok" or "failed".

The first plan had `--accent` at 66% lightness. White on it is 4.31:1, below AA, so it is 62% (5.1:1).

## Type

- UI: Inter, 13 to 14 px in dense lists, 15 px in chat. Code, ids, branch names, counts: JetBrains Mono. Both are
  self-hosted from `@fontsource-variable/*`, with the system fonts as fallback.
- Section labels: small uppercase with letter spacing, in `--text-muted`, sometimes after a small accent square.

## Shape

- Radius: 6 px for chips, 8 px for inputs and rows, 12 px for panels, 16 px for primary buttons.
- Borders over shadows. One-pixel `--line` borders.
- Selected list row: `--raised` background plus a 2 px `--accent` bar on the left.

## Layout

The workspace view has three panes and a rail. The plan (Board, Usage, review states, and the right panel tabs come
later):

```text
┌────┬──────────────────┬──────────────────────────────┬─────────────────────┐
│rail│ workspaces       │ chat with the worker         │ right panel (tabs): │
│    │ grouped by state │ messages, tool calls,        │ changes, pipeline,  │
│Home│ ▸ Needs you      │ proposals                    │ PR, artifacts,      │
│Board│▸ Running        │                              │ terminal            │
│Proj│ ▸ In review      │                              │                     │
│Use │ ▸ Parked         │ composer: model, thinking,   │ file list with      │
│    │                  │ steer / queue                │ +/- counts          │
└────┴──────────────────┴──────────────────────────────┴─────────────────────┘
```

- **Rail:** icons for Home, Board (kanban), Projects, Usage, Settings. Badges for counts that need you.
- **Workspace list:** grouped by project, then by state, newest first. Each row has name, time, one live status line
  ("Thinking...", "review 1/2", "waiting for Strata", "gates failed"), and chips (`PR #42`, `lane 2/5`, routed
  model).
- **Chat:** messages with rendered Markdown, collapsed tool calls, and proposals shown as numbered option blocks.
  The composer row shows project, isolation (worktree, branch, main), model, and thinking level.
- **Right panel:** tabs. The changes tab lists files with `Added`/`Modified` and `+`/`-` counts, plus a header card
  for the PR (state badge, branch → base, checks).
- **Top bar:** a centered command bar ("Search or run a command", `Ctrl K`), the theme menu, and the server status
  dot.

What exists now:

- **Rail:** Home, Board, Workspaces, Projects, Usage. A module adds an entry with `rail: { order, icon }` on its page; only pages
  that exist get one.
- **Workspace list:** one group per project, sorted by name, with a divider heading when there are two or more.
  Inside a project: Active, then Parked; Archived behind "Show archived". Newest activity first. Each row: name,
  age, branch, and a status line from the agent ("Working", "Idle", "Agent failed", "Parked").
  Filtered to one project on `#/workspaces/in/<project>`. The list can be hidden to a thin strip.
- **Middle:** the chat. Header: name, branch, agent status, context meter, Compact, Stop agent. Under it, the chat
  bar: the workspace's chats as links (active worker chat, side chats with an eye icon, older worker chats dimmed
  with a history icon), a rename pencil, and New chat, Side chat, and Side chat with context. A side chat says it is
  read-only at the top. An older worker chat says so with a Make active button and has no composer. The composer row
  holds an image button and the model and thinking selects. Images come in by paste, drop, or the button and show
  as 64 px thumbnails with a round remove button above the text; a drop lights the box border in the accent. A
  warning shows above the box when the chat's model takes no images. Extension dialogs show as cards; select dialogs
  as numbered option rows.
- **Images in messages:** thumbnails at most 192 px high with a `--line` border, under the user's text and under a
  tool call (visible while it is folded). A click opens the full-size viewer over a dimmed page; Escape closes it.
  Images the agent links by path show the same way with the path under them. A remote image is a small box with
  its host and a Load button (ADR 0061).
  With no workspace selected, the middle shows the "Start a workspace" form.
- **Right panel:** a "Details" tab (workspace info, rename, park, resume, archive, then the module panels Actions
  and Unity as collapsible sections), a "Changes" tab, a "PR" tab, and a "Terminals" tab. The Changes tab is wide: a scope
  select, the file list with status chips and `DiffCount`, and the diff with line numbers, `--diff-add` and
  `--diff-del` tinted rows, and code colored with role tokens. A comment button sits on each line's left edge. The Terminals tab widens the column to 40rem (at most
  half the window) and shows a tab per terminal with a status dot and a close button, a new button, a font button
  that opens a "Terminal font" field, the terminal, and a note that terminals end when the server stops. It can be hidden to a thin strip. The PR tab has a header card
  (number, title, state chip, branch → base, review and conflict chips), the checks as rows with a state chip and a
  link, and the watch with its state chip and tries.
- **Top bar:** brand, theme menu, server status dot. The command bar comes later. The brand is the spore logo in
  `--accent` before the "pi-spore" name.
- **Icons:** the favicon is the spore logo in the theme's `--accent`. The page redraws it when the theme changes.
  `/icon.svg` is the static fallback, in the Spore Night accent. The home screen and PWA icons are fixed PNGs: the
  Spore Night accent logo on `#15131b`.
- Widths: from 1100 px all three panes fit; from 1280 px the side columns get wider. Below 1100 px, hide a side
  column with its button.

## Components

In `@pi-spore/ui` (`packages/ui/src/components`):

| Component | Use |
|---|---|
| `Button` | `primary` (16 px radius, one per view), `secondary`, `ghost`, `danger`; sizes `sm`, `md`, `icon` |
| `Chip` | 6 px radius label; tones `neutral`, `accent`, `ok`, `fail`, `warn`, `run`; `mono` for ids and branches |
| `StatusLine` | a colored dot and one line of live state |
| `ListRow` | a link row; selected: `--raised` and a 2 px accent bar on the left |
| `SectionLabel` | small uppercase label, optionally after an accent square |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | the tab bar (Radix Tabs) |
| `Panel`, `PanelHeader` | 12 px radius bordered box with a section label title |
| `CollapsibleSection` | a titled section that folds (Radix Collapsible) |
| `DiffCount` | `+12 -3` in the diff colors (for the changes tab) |
| `EmptyState` | icon, title, help line, optional action |
| `Notice` | info, warning, or error box; errors are announced |
| `Field`, `Input`, `Textarea`, `Select`, `Checkbox` | form controls, 8 px radius; `Select` is native |
| `Table`, `TableHead`, `TableCell` | dense tables |
| `Page`, `PageHeader` | a full page inside the shell |
| `ImageViewer` | a full-size image over a dimmed page (Radix Dialog); Escape or the close button closes it |
| `SporeLogo` | the pi-spore logo in the text color; `sporeLogoSvg(color)` gives it as a standalone SVG |
| `Spinner`, `Tooltip`, `ThemeMenu` | |

The PR header card lives in the `github-pr` module.

## Accessibility

- Every focusable element shows a 2 px `--accent-strong` outline on keyboard focus.
- Icon-only buttons and rail links have an `aria-label` and a tooltip.
- `prefers-reduced-motion` stops animations and transitions.
