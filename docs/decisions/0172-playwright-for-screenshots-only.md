# 0172. Playwright is a dev tool for screenshots only

- Status: Accepted
- Date: 2026-11-10

## Context

The UI tests run in happy-dom, which does not lay out the page. They cannot catch overflow, clipping, or text that
is too small to read, for example a Settings page that scrolls sideways at 1440 px. Agents and reviewers need to see
the real UI in a real browser. The testing rules in `AGENTS.md` say tests are deterministic, with no network and no
real clock. A real browser is neither.

## Decision

- `playwright` is an exact-version devDependency in the root `package.json`, used only by
  `scripts/screenshot.mjs`.
- The script opens a page of a running dev server (`run_action dev`, ADR 0161), saves a full-page PNG, and says
  whether the page scrolls sideways. It is a look tool, not a test.
- It is not part of `npm test`, the pipeline gates, or CI (user decision, 2026-11-10).
- No script and no `npm ci` step downloads browsers. The pinned version matches the Chromium already in
  `~/.cache/ms-playwright`. A missing browser fails with Playwright's error and the install command
  (`npx playwright install chromium`).
- The script loads only the dev server's origin. It blocks every other request.

## Consequences

- `npm run check` and `npm test` stay as fast as before.
- A Playwright upgrade may need a new Chromium. Whoever upgrades runs the install command once.
- A visual bug found with the tool still needs its own fix and, where it can, a happy-dom test of the behavior.
