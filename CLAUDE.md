# CloudShell - Development Notes

Web-based terminal + Claude Code integration. Express server with WebSocket PTY management and Agent SDK chat.

## Development

```bash
npm install && cd web && npm install && cd ..
npm run build:all       # TypeScript + Vite
npm run check-types     # Both backend AND frontend — run before pushing
npm run dev             # API (nodemon) + Vite together
```

### Ports & Networking
- **Single port**: `localhost:4444` (PORT env var or --port flag)
- In dev, Vite runs as Express middleware (no separate port). HMR works over the same port.
- **WebSocket**: `localhost:4444/ws/pty` (PTY I/O, `noServer` mode with manual upgrade routing)

## Architecture

### PTY Server (`src/pty-server.ts`)
- Session management: create, attach (reconnect with scrollback replay), input, resize, kill
- Sessions keyed by tab ID, one PTY per session
- `CLAUDECODE` env var stripped from spawned processes (prevents nested-session error)
- **Race condition guard**: `onExit` handler checks `sessions.get(id) === session` before deleting, because killing an old PTY during `pty_create` replacement triggers the old `onExit` asynchronously after the new session is added

### Agent SDK (`src/agent-stream.ts`)
- Wraps `@anthropic-ai/claude-agent-sdk` query() with SSE streaming
- In-memory session tracking (tabId → sessionId) for conversation continuity
- Stale session retry: auto-retries without resume if session ID is expired
- Exit code 1 diagnosis: reads `.claude/debug/latest` for "prompt too long" errors

### Terminal Frontend (`web/src/components/TerminalTab.tsx`)
- ghostty-web WASM terminal with custom WebGL2 renderer
- Used for both Shell tabs (default shell) and Claude tabs (`command="claude"`)
- Tab visibility via `display:none` (not unmount) to preserve terminal state
- Reconnect logic: `pty_attach` first, falls back to `pty_create` if session gone
- `createdSessions` Set is module-level (survives re-renders, resets on page refresh)

### Chat Frontend (`web/src/components/AgentTab.tsx`)
- Agent SDK chat via SSE (`POST /api/chat`)
- Renders: markdown, tool use blocks, thinking blocks, sub-agent tasks
- Context meter, file upload, @-mentions, slash commands
- Model/thinking settings live in App.tsx (`TabSettings`), accessed via TabBar context menu
- Mobile: `visualViewport` API tracks keyboard height, container shrinks accordingly
- Mobile: `text-base` (16px) on inputs prevents iOS Safari auto-zoom
- Mobile: textarea blurs on submit to dismiss keyboard

### Tab Bar (`web/src/components/TabBar.tsx`)
- Tab overflow: when tabs exceed bar width, hidden tabs go into a ⋯ overflow dropdown
- Context menu: right-click (desktop) or long-press (mobile) on any tab
  - Agent tabs: model radio list, thinking toggle with effort/budget, rename, close
  - Shell/Claude tabs: rename, close
- Long-press detection: 500ms `setTimeout` on `touchstart`, cancelled if finger moves >5px
- Synthetic mouse event suppression: timestamp-based 500ms grace period after touch context menu open
- Portal pattern: `createPortal` + `data-portal-phosphor` for theme scoping
- Viewport clamping: `useLayoutEffect` clamps menu position before paint
- Mobile: close buttons hidden (use context menu), single + button with dropdown for new tabs

## Key Patterns

- **SSE abort detection**: Use `res.on('close')` not `req.on('close')` — Express 5 fires `req.close` when body is consumed
- **Tab state preservation**: Tabs hidden with `display:none`, not unmounted, to preserve ghostty-web terminal state
- **Base64 PTY I/O**: All PTY data encoded as base64 over JSON WebSocket messages
- **WebGL cursor**: Cursor rendered by WebGLRenderer (block/bar/underline), color = foreground color, blink enabled
- **State lifting**: Per-tab settings (model, thinking) owned by App.tsx, passed to TabBar (context menu) and AgentTab (API calls)
- **Mobile keyboard**: `visualViewport` resize listener tracks keyboard height; container shrinks by that amount
- **Long-press → context menu**: 500ms touch timer with 5px scroll threshold cancellation; dismiss handler has 500ms grace period to ignore synthetic mousedown events

## Common Issues

| Symptom | Fix |
|---------|-----|
| `posix_spawnp failed` | npm strips execute bit from node-pty's `spawn-helper`. Run `npm install` (postinstall script fixes it) or manually `chmod +x` the binary |
| Claude tab exits immediately | Check `CLAUDECODE` env var is stripped in pty-server.ts |
| Typing produces no output | PTY session race — old onExit deleted new session (see guard) |
| Chat returns only `[DONE]` | `res.on('close')` not `req.on('close')` for SSE abort |
| "Session exited (code 1)" | Missing ANTHROPIC_API_KEY or context too long |
| Every-other-refresh broken | onExit race condition in pty_create replacement |
