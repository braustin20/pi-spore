# Visual design direction

- Date: 2026-11-06
- Status: direction for the styling slice. The current CSS is a temporary placeholder.
- pi-spore uses its own name, palette, and theme names. It uses no other product's logos, images, fonts, colors, or
  branding.

## Feel

Dark, calm, and dense, in the style of current agent workbenches. A near-black background with a slight violet
tint, gray-violet panels separated by thin borders, and one accent color for the primary action, the selection, and
live state. Information is packed into small chips and one-line status rows, not large cards.

## Themes

Colors are swappable. The look of the components (shapes, spacing, type, layout) stays fixed; the palette changes.

- Components use only role tokens: `--bg`, `--panel`, `--raised`, `--line`, `--text`, `--text-muted`,
  `--accent`, `--accent-strong`, `--on-accent`, `--ok`, `--fail`, `--warn`, `--run`, `--diff-add`, `--diff-del`.
  No component uses a raw color.
- A theme is one set of values for those tokens, as a `[data-theme="<id>"]` block of CSS variables.
- A theme menu (top bar and Settings) lists the themes with a color preview and applies the choice at once,
  without a reload.
- v1 keeps the choice in the browser (`localStorage`). When the settings module lands, it moves to
  `~/.pi-spore/settings.json`, so the CLI and every browser share it.
- Built-in themes: **Spore Night** (the default, below), **Ayu Dark** (matches the user's Pi theme), and one light
  theme. Adding a theme means adding one token block and one menu entry.
- Every theme must meet WCAG AA contrast for text on `--bg`, `--panel`, and `--accent`. A test checks this for
  each built-in theme.

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
| `--accent` | 258 90% 66% | Primary buttons, selection bar |
| `--accent-strong` | 258 95% 80% | Links, active nav, live-state text |
| `--on-accent` | 0 0% 100% | Text on `--accent` |
| `--ok` | 145 55% 55% | Passed gates, merged |
| `--fail` | 355 75% 66% | Failed gates, blocking findings |
| `--warn` | 38 90% 62% | Waiting for you, approvals, warnings |
| `--run` | 210 85% 66% | Running |
| `--diff-add` | 145 55% 55% | `+` line counts |
| `--diff-del` | 355 75% 66% | `-` line counts |

Status colors are kept apart from the accent, so "selected" never reads as "ok" or "failed".

## Type

- UI: Inter (or the system UI font), 13 to 14 px in dense lists, 15 px in chat.
- Code, ids, branch names, counts: JetBrains Mono (or `ui-monospace`).
- Section labels: small uppercase with letter spacing, in `--text-muted`, sometimes after a small accent square.

## Shape

- Radius: 6 px for chips, 8 px for inputs and rows, 12 px for panels, 16 px for primary buttons.
- Borders over shadows. One-pixel `--line` borders.
- Selected list row: `--raised` background plus a 2 px `--accent` bar on the left.

## Layout

The main screen has three panes and a rail:

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
- **Workspace list:** grouped by state, newest first. Each row has project, name, time, one live status line
  ("Thinking...", "review 1/2", "waiting for Strata", "gates failed"), and chips (`PR #42`, `lane 2/5`, routed
  model).
- **Chat:** messages with rendered Markdown, collapsed tool calls, and proposals shown as numbered option blocks.
  The composer row shows project, isolation (worktree, branch, main), model, and thinking level.
- **Right panel:** tabs. The changes tab lists files with `Added`/`Modified` and `+`/`-` counts, plus a header card
  for the PR (state badge, branch → base, checks).
- **Top bar:** a centered command bar ("Search or run a command", `Ctrl K`), the theme menu, and the server status
  dot.

## Components to build in the styling slice

Chip, status line, list row with selection bar, section label, primary/secondary/ghost buttons, tab bar, panel,
diff-count pair, PR header card, empty state, the theme menu, and the three-pane shell. Pages built before that
slice use the placeholder CSS classes and get restyled in one pass.
