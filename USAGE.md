# CloudShell User Guide

CloudShell is a browser-based development environment with terminal access and AI chat.

## Getting Started

1. Start the server:
   ```bash
   cloudshell --open
   ```
   Or for development:
   ```bash
   npm run dev
   ```
2. Open `http://localhost:4444` in your browser.

If a password is set via `CLOUDSHELL_PASSWORD`, you'll see a login screen first.

## Tabs

CloudShell uses a tabbed interface. Create new tabs with the buttons on the right side of the tab bar.

### Shell

A full terminal running your default shell (zsh/bash). Works just like a local terminal — supports colors, vim, tmux, etc. The working directory starts at the project root.

On mobile/touch devices, a toolbar appears above the keyboard with Tab, Esc, Ctrl, and arrow keys.

### Claude

Runs Claude Code CLI in a terminal. Same as typing `claude` in a shell, but in its own tab. Useful for having a persistent Claude Code session alongside your shells.

### Agent

An AI chat interface powered by the Anthropic Agent SDK. Features:

- **Markdown rendering** — Responses render with full markdown (code blocks, tables, lists)
- **Tool use display** — See what tools the AI is using (file reads, searches, bash commands, subagents) with expandable results. Shift-click a tool to see raw input/output.
- **File upload** — Click the + button or drag-and-drop files and images into the chat
- **@-mentions** — Type `@` followed by a filename to include file contents in your message. Autocomplete suggestions appear as you type.
- **Slash commands** — Type `/` to see available commands
- **Thinking toggle** — Enable extended thinking with configurable effort level and token budget (brain icon next to the input)
- **Context meter** — Shows how much of the context window is used
- **Model selector** — Switch between Sonnet, Haiku, and Opus

## Tab Management

- **Close** — Click the X on any tab (including the last one)
- **Rename** — Double-click a tab title to rename it
- **Reorder** — Drag and drop tabs to rearrange them
- Tab state persists across page refreshes

## Settings

Click the cloud icon in the top-left corner to access:

- **Theme** — Choose from System, Light, Dark, Solarized Dark, Dracula, Monokai, Catppuccin, Gruvbox, or Tokyo Night
- **Log out** — Available when password protection is enabled

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required for Agent tabs |
| `CLOUDSHELL_PASSWORD` | Set to enable password protection |
| `SHELL` | Override default shell (default: `/bin/zsh`) |

## CLI Options

```
  -p, --port <number>   Port (default: 4444)
  --cwd <path>          Working directory (default: cwd)
  --open                Open browser on startup
```
