# CloudShell

Web-based terminal with Claude Code integration. Runs a local server that provides shell terminals, Claude Code sessions, and an Agent SDK chat interface — all in browser tabs.

## Install

```bash
npm install -g cloudshell
```

## Quick Start

```bash
# Set your API key (required for Chat tabs)
export ANTHROPIC_API_KEY=sk-...

# Run from any directory
cloudshell --open
```

Or use without installing:

```bash
npx cloudshell --open
```

Opens at `http://localhost:4444`. Shells default to your current working directory.

## Tab Types

- **Shell** — Full terminal (zsh/bash) via node-pty + ghostty-web with WebGL rendering
- **Claude** — Claude Code CLI running in a terminal PTY (same as running `claude` locally)
- **Chat** — Agent SDK chat with markdown rendering, tool use display, thinking toggle, and context meter

## CLI Options

```
cloudshell [options]

  -p, --port <number>   Port to listen on (default: 4444)
  --cwd <path>          Working directory for shells and agent (default: cwd)
  --open                Open browser on startup
```

## Development

```bash
git clone https://github.com/darrinm/cloudshell.git
cd cloudshell
npm install && cd web && npm install && cd ..
npm run build:all
npm start
```

```bash
npm run dev          # Single server with Vite middleware + nodemon
npm run build        # TypeScript → dist/
npm run build:web    # Vite → web/dist/
npm run build:all    # Both
npm run check-types  # Both backend and frontend
npm run format       # Prettier
```

## Architecture

```
src/
  server.ts          Express + WebSocket + CLI entry point
  pty-server.ts      PTY session management (create/attach/input/resize/kill)
  agent-stream.ts    Claude Agent SDK streaming wrapper
  agent-events.ts    SDK event → SSE event translation
  types.ts           Shared types (WS messages, agent events, context usage)

web/src/
  App.tsx            Tab management (shell/claude/chat)
  components/
    TabBar.tsx       Tab bar with add/close/rename
    TerminalTab.tsx  ghostty-web terminal (shell + claude tabs)
    WorkTab.tsx      Agent SDK chat interface
    WebGLRenderer.ts Custom WebGL2 terminal renderer
    ContentBlocksDisplay.tsx  Markdown + tool use rendering
    ContextMeter.tsx Token usage visualization
    ThinkingToggle.tsx Extended thinking controls
```

### Key Dependencies

| Component | Library |
|-----------|---------|
| Terminal | ghostty-web (WASM) + custom WebGL2 renderer |
| PTY | node-pty |
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| Server | Express 5 + ws |
| Frontend | React 19 + Tailwind + Vite |

### Protocols

- **WebSocket** (`/ws/pty`) — Binary PTY I/O (base64-encoded), create/attach/resize/kill
- **SSE** (`POST /api/chat`) — Agent SDK streaming events
- **REST** — `/api/config`, `/api/upload`, `/api/files/:filename`

## Environment Variables

- `ANTHROPIC_API_KEY` — Required for Chat tabs (Agent SDK)
- `SHELL` — Shell to use for terminal tabs (default: `/bin/zsh`)
- `CLOUDSHELL_PASSWORD` — Set to enable password protection

## License

MIT
