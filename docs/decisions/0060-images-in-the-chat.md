# 0060. Images in the chat: sent with prompts, shown by reference, linked files from the workspace

- Status: Accepted
- Date: 2026-11-07
- Requirements: R5.1, R14.2

## Context

R5.1 asks for images in the chat. Pi takes images with `prompt`, `steer`, and `follow_up` as `ImageContent` blocks
(`{ type: "image", data: <base64>, mimeType }`) and keeps them in user messages and tool results, in its events and
in the session file. A screenshot is often a few MiB of base64. The server relays every Pi event to the page and
sends the whole chat in each snapshot, so images inline would make both large and slow.

Agents also write images to disk (a plot, a Unity camera capture) and link them in Markdown by a local path. The
browser cannot load a local path, and a route that reads files from disk is a security boundary.

## Decision

- **Sending.** `POST /api/agents/:id/prompt` takes `images: [{ mimeType, data }]`: PNG, JPEG, WebP, or GIF as
  base64. The server checks the count (default at most 8), the decoded size (default at most 10 MiB each), and that
  the bytes start like the type they claim, then passes them to Pi with the prompt, steer, or follow-up. A message
  may be only images. The limits are the settings `agents.maxImagesPerMessage` and `agents.maxImageBytes` (architecture 13).
- **By reference.** Before the server keeps or relays a Pi event, and when it reads a session file, it replaces
  each image block's `data` with `ref`, the SHA-256 of the base64 data, plus the decoded size. Pages fetch the bytes
  from `GET /api/agents/:id/images/:ref`. The server keeps the decoded bytes in a memory cache (default 64 MiB); an
  image the cache dropped is read again from the chat's session file. A chat can read only refs it has shown.
- **Linked files.** `GET /api/agents/:id/linked-image?path=` serves an image file an agent linked: a path absolute
  or relative to the workspace folder. It answers only when, after resolving symlinks, the file is inside the
  workspace folder or the workspace's artifacts folder (`artifacts/workspaces/<id>/`, ADR 0070), the real name ends
  in `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif`, it is a regular file of at most the image size limit, and its bytes
  match the extension. The file is opened without following a final symlink and must be the same inode that was
  checked.
- Both routes need the user's token like every other route. The page fetches the bytes with the token header and
  shows them as a blob URL, so no token goes into an image URL. Responses carry the checked type,
  `nosniff`, and `content-security-policy: default-src 'none'; sandbox`.
- Anything else the agent links stays a plain link. Remote images: ADR 0061.

## Consequences

- Snapshots and live events stay small however many images a chat has. A page loads only the images it shows.
- The session file stays the one store of chat images; pi-spore writes no copy.
- An image seen only in a live event and never written to the session file (a partial tool result) is gone once the
  cache drops it. The page then shows that it is not available.
- Reading a dropped image reads the whole session file once.
- A narrow race remains: a folder on the path swapped for a symlink between the check and the open. Only a process
  that can already write the workspace can do it, and that process can already read the same files.
