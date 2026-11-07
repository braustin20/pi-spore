# 0061. Remote images in the chat load only on a click

- Status: Accepted
- Date: 2026-11-07
- Requirements: R5.1

## Context

An agent can write a Markdown image with an `http:` or `https:` address, from a web page it read or a prompt
injection. If the page loads it, the browser asks that site for the image: the site learns the user's IP address, the
time, and that the chat was open. A tracking address can also carry data the agent put into the URL. pi-spore is a
local tool and does not otherwise reach out to the web from the page.

## Decision

- A remote Markdown image shows as a box with its alt text, the site's host, and a Load button. Nothing is fetched
  until the user clicks Load, once per image.
- After the click the image loads with `referrerPolicy="no-referrer"` and opens in the same full-size viewer as
  other chat images. A failed load says so.
- Remote links (`[text](https://...)`) stay plain links.
- No setting to load all remote images yet.

## Consequences

- Opening a chat sends no requests to other sites.
- The user sees which site an image comes from before loading it.
- Reading a chat with many remote images takes a click each. A setting to trust some hosts can come later.
