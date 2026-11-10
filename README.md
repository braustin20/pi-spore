<div align="center">

<img src="docs/assets/logo.svg" alt="pi-spore logo" width="120">

# pi-spore

A local workbench for Pi coding agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-7b47f5.svg)](LICENSE)
[![Node 26](https://img.shields.io/badge/node-26-7b47f5.svg)](.nvmrc)

</div>

pi-spore is a local, single-user workbench. It runs [Pi](https://github.com/earendil-works/pi) coding agents across
many Git projects. It makes the worker → reviewer → adversarial reviewer flow durable, enforced, and visible. Unity
projects get first-class support.

It is a Node server, a React web UI, and a small CLI. The server binds to `127.0.0.1` only. There are no accounts and
no hosting.

![A workspace: the chat asks to open a PR, and the Pipeline tab shows a passed run](docs/assets/screenshot-chat.png)

## Features

- **Workspaces.** Each piece of work gets its own Git worktree and branch, with its chat, terminals, changes, and
  artifacts.
- **Chats.** Every agent is a real `pi` process with your normal Pi setup. Read-only side chats run next to the main one.
- **Pipelines.** A worker writes the code. Fresh reviewers check it, and check and test gates must pass.
- **Home and board.** Questions and approvals from agents wait on Home. A kanban board holds planned work, and a card
  starts a workspace.
- **Model router and usage.** The `spore/auto` model picks a model for each request. The Usage page shows plan
  windows and token use.
- **Unity.** pi-spore opens and closes editors, copies `Library/` into new worktrees, and runs EditMode and PlayMode
  tests as gates.
- **Phone.** The UI works on a phone and installs as a web app. It reaches the server through `tailscale serve`.

## Screenshots

All screenshots show demo data from a dev server.

| Home | Board (Spore Day theme) |
| :---: | :---: |
| ![Home with a PR approval from an agent](docs/assets/screenshot-home.png) | ![The kanban board in the light theme](docs/assets/screenshot-board.png) |

<p align="center">
  <img src="docs/assets/screenshot-phone.png" alt="Home and the board on a phone" width="480">
</p>

## Quick start

You need:

- Node 26 (see `.nvmrc`)
- `git`
- [Pi](https://github.com/earendil-works/pi), set up and logged in, with `pi` on your `PATH`

```sh
nvm use
npm ci
npm run build
npm start
```

Then open <http://127.0.0.1:7420>. Set `PI_SPORE_PORT` to use another port.

The CLI talks to the same server:

```sh
node packages/cli/dist/main.js health
```

## Docs

- [Vision and requirements](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Visual design](docs/design.md)
- [Decisions (ADRs)](docs/decisions/)

## License

[MIT](LICENSE)
