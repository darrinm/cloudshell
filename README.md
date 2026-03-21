# CloudShell

Web-based terminal with Claude Code integration. Runs a local server with shell terminals, Claude Code sessions, and an AI chat interface — all running in parallel browser tabs.

https://github.com/user-attachments/assets/f9a03208-deb0-4bf6-a5e5-153d06308afc

## Install

```bash
npm install -g @darrinm/cloudshell
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cloudshell --open
```

Or without installing:

```bash
npx @darrinm/cloudshell --open
```

Opens at `http://localhost:4444`. If a password is set via `CLOUDSHELL_PASSWORD`, you'll see a login screen first.

## Tab Types

All tabs run independently and in parallel — run builds in a Shell while chatting in an Agent tab and monitoring logs in another Shell. Create new tabs with the buttons on the right side of the tab bar.

**Shell** — Full terminal (zsh/bash) via node-pty with WebGL rendering. Supports colors, vim, tmux — everything your local terminal does. On mobile, a toolbar appears above the keyboard with Tab, Esc, Ctrl, and arrow keys.

**Claude** — Claude Code CLI in a dedicated terminal tab. Same as running `claude` in a shell, but isolated.

**Agent** — AI chat powered by the Anthropic Agent SDK:
- **Markdown rendering** — Code blocks, tables, lists
- **Tool use display** — Expandable results for file reads, searches, bash commands, subagents. Shift-click for raw input/output.
- **File upload** — Click + or drag-and-drop files and images
- **@-mentions** — Type `@` followed by a filename to include file contents
- **Slash commands** — Type `/` to see available commands
- **Thinking toggle** — Extended thinking with configurable effort/budget (brain icon)
- **Context meter** — Shows context window usage
- **Model selector** — Sonnet, Haiku, Opus

### Tab Management

- **Close** — Click the X on any tab
- **Rename** — Double-click a tab title
- **Reorder** — Drag and drop tabs
- Tab state persists across page refreshes

### Settings

Click the cloud icon in the top-left corner:
- **Theme** — System, Light, Dark, Solarized Dark, Dracula, Monokai, Catppuccin, Gruvbox, Tokyo Night
- **Log out** — Available when password protection is enabled

## CLI Options

```
cloudshell [options]

  -p, --port <number>   Port (default: 4444)
  --cwd <path>          Working directory (default: cwd)
  --open                Open browser on startup
```

## Authentication

CloudShell supports three auth modes, detected from environment variables:

| Mode | Variables | Description |
|------|-----------|-------------|
| **Password** | `CLOUDSHELL_PASSWORD` | Simple shared password |
| **GitHub OAuth** | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Direct OAuth flow |
| **GitHub OAuth Proxy** | `CLOUDSHELL_OAUTH_PROXY_URL` + `CLOUDSHELL_OAUTH_SECRET` | Proxied OAuth for deployments without a public callback URL |
| **None** | _(no auth vars set)_ | Open access (default) |

Optional: `GITHUB_ALLOWED_USERS` — comma-separated list of GitHub usernames to allow.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | For Agent tabs | Claude API access |
| `CLOUDSHELL_PASSWORD` | No | Enable password protection |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth app client secret |
| `GITHUB_ALLOWED_USERS` | No | Restrict GitHub login to these users |
| `SHELL` | No | Override default shell (default: `/bin/zsh`) |

## Prerequisites

- Node.js >= 20
- Native build tools for node-pty and better-sqlite3 (Xcode CLI on macOS, `build-essential` on Linux)

## Development

```bash
git clone https://github.com/darrinm/cloudshell.git
cd cloudshell
npm install && cd web && npm install && cd ..
npm run dev          # Single server with Vite HMR + nodemon
```

```bash
npm run build        # TypeScript backend
npm run build:web    # Vite frontend
npm run build:all    # Both
npm run check-types  # Both backend and frontend
npm run format       # Prettier
npm start            # Production server
```

## License

MIT
