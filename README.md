# CloudShell

Web-based terminal with Claude Code integration. Runs a local server with shell terminals, Claude Code sessions, and an AI chat interface — all in browser tabs.

## Install

```bash
npm install -g cloudshell
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cloudshell --open
```

Or without installing:

```bash
npx cloudshell --open
```

Opens at `http://localhost:4444`.

## Tab Types

**Shell** — Full terminal (zsh/bash) via node-pty with WebGL rendering. Supports colors, vim, tmux — everything your local terminal does.

**Claude** — Claude Code CLI in a dedicated terminal tab. Same as running `claude` in a shell, but isolated.

**Work** — AI chat powered by the Anthropic Agent SDK:
- Model selection (Sonnet, Haiku, Opus)
- Extended thinking with configurable effort/budget
- Tool use display with expandable results
- File upload and image paste
- @-mentions for including file contents
- Slash commands
- Context usage meter
- Markdown rendering with syntax highlighting

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
