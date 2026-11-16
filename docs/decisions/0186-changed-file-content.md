# 0186. One side of a changed file, and images in the Changes tab

- Status: Accepted; adds to [0090](0090-changes-and-pull-requests.md), uses [0060](0060-images-in-the-chat.md)
- Date: 2026-11-16
- Requirements: R8.1, R8.2

## Context

The Changes tab shows "Binary file" for every binary file. Game and UI work changes textures and screenshots, and
the user cannot review them. A rendered Markdown view needs the same thing: the whole old or new file, not hunks.
`Exec` gives stdout as a string, which breaks the bytes of a binary file.

## Decision

- `ChangeOps` gets one optional method: `content(location, scope, file, side, maxBytes)`, the bytes of the `old` or
  `new` side of a file that `files` lists for that scope. A side that does not exist (the old side of an added file,
  the new side of a deleted one) is 404 `side_missing`. A side over `maxBytes` is 413 `file_too_large`.
- Git reads the new side of `uncommitted` from the working tree with `readFileInside`, inside the workspace folder
  only. Every other side comes from `git cat-file -s` (the size, checked first) and `git cat-file blob` on
  `<rev>:<path>`. The old side's rev is the left side of the scope's diff: HEAD for `uncommitted` and `staged`, the
  fork point for `line`, the parent for `record`. The new side's rev is the index for `staged`, the tip for `line`,
  and the commit for `record`. A rename's old side uses its old path.
- Bytes from Git: `ExecOptions.encoding: "buffer"` makes `exec` resolve `ExecResult<Buffer>`. Without it, output
  stays a string. One option on the existing seam, so fakes and other callers do not change.
- Route `GET /api/changes/workspaces/:id/content?scope=&record=&path=&side=old|new`. Only a path that `files` lists
  for the scope; any other path is 404 `file_not_changed`. Limit: 20 MiB (module option `maxContentBytes`).
  - A path with an image extension (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, the types of ADR 0060) answers with
    that type only when the bytes match it; else 415 `not_an_image`.
  - A file `files` does not mark binary answers `text/plain; charset=utf-8`.
  - Any other binary file is 415 `not_supported`.
  - Every answer has `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, and
    `cache-control: no-store` (ADR 0060's headers).
- SVG is text. It keeps the text diff and is never shown as a picture, since it can carry script.
- The pure image helpers (`sniffImage`, `imageTypeOfPath`, `imageHeaders`) live in `@pi-spore/shared`, so
  `agents` and `changes` share them. The web hook `useBlobUrl` lives in `@pi-spore/module-api`.

## Consequences

- The Changes tab shows an added image, a deleted image, or old and new side by side with their sizes.
- Other providers can add `content` later. Without it, the tab keeps the binary note.
- Comments on images are not supported.
