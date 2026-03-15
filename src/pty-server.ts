import * as path from 'path';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

import type { ClientMessage } from './types.js';

interface PtySession {
  pty: pty.IPty;
  scrollback: Buffer[];
  scrollbackSize: number;
  ws: WebSocket | null;
  lastCwdName: string | null;
}

const MAX_SCROLLBACK = 1024 * 1024; // 1MB

// Match OSC 7: ESC ] 7 ; file://host/path BEL  or  ESC ] 7 ; file://host/path ESC \
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)\x07|\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)\x1b\\/;

const sessions = new Map<string, PtySession>();

function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function handlePtyMessage(
  ws: WebSocket,
  msg: ClientMessage,
  defaultCwd: string,
  githubToken?: string,
) {
  switch (msg.type) {
    case 'pty_create': {
      // Kill existing session if any
      const existing = sessions.get(msg.id);
      if (existing) {
        existing.pty.kill();
        sessions.delete(msg.id);
      }

      const shell = process.env.SHELL || '/bin/zsh';
      const command = msg.command;
      const cwd = msg.cwd || defaultCwd;

      try {
        const p = pty.spawn(
          command ? command.split(' ')[0] : shell,
          command ? command.split(' ').slice(1) : [],
          {
            name: 'xterm-256color',
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            cwd,
            env: (() => {
              const { CLAUDECODE, ...env } = process.env;
              return {
                ...env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
              };
            })() as Record<string, string>,
          },
        );

        const session: PtySession = {
          pty: p,
          scrollback: [],
          scrollbackSize: 0,
          ws,
          lastCwdName: null,
        };
        sessions.set(msg.id, session);

        p.onData((data: string) => {
          // Store in scrollback
          const buf = Buffer.from(data, 'utf-8');
          session.scrollback.push(buf);
          session.scrollbackSize += buf.length;
          // Trim scrollback if too large
          while (session.scrollbackSize > MAX_SCROLLBACK && session.scrollback.length > 1) {
            session.scrollbackSize -= session.scrollback.shift()!.length;
          }

          // Send to client
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            const b64 = buf.toString('base64');
            send(session.ws, { type: 'pty_output', id: msg.id, data: b64 });
          }

          // Parse OSC 7 for cwd updates
          const osc7Match = OSC7_RE.exec(data);
          if (osc7Match) {
            const rawPath = decodeURIComponent(osc7Match[1] || osc7Match[2]);
            const dirName = path.basename(rawPath) || rawPath;
            if (dirName !== session.lastCwdName) {
              session.lastCwdName = dirName;
              if (session.ws && session.ws.readyState === session.ws.OPEN) {
                send(session.ws, { type: 'pty_cwd', id: msg.id, name: dirName });
              }
            }
          }
        });

        p.onExit(({ exitCode }) => {
          // Only delete if this session is still the active one (not replaced by a new pty_create)
          if (sessions.get(msg.id) === session) {
            if (session.ws) {
              send(session.ws, { type: 'pty_exit', id: msg.id, exitCode });
            }
            sessions.delete(msg.id);
          }
        });

        send(ws, { type: 'pty_started', id: msg.id });

        // Inject OSC 7 precmd hook for shell tabs (not custom commands like 'claude')
        if (!command) {
          // Detect shell and inject appropriate hook
          const shellBase = path.basename(shell);
          if (shellBase === 'zsh') {
            // Zsh: add precmd function that emits OSC 7
            p.write(
              ' __cloudshell_precmd() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$(pwd)"; }; precmd_functions+=(__cloudshell_precmd); clear\n',
            );
          } else if (shellBase === 'bash') {
            // Bash: use PROMPT_COMMAND
            p.write(
              ' PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\a" "$(hostname)" "$(pwd)"\'; clear\n',
            );
          }
        }

        // Replay scrollback for reconnect (there won't be any for new sessions, but this handles reconnect)
      } catch (err) {
        send(ws, {
          type: 'pty_error',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'pty_input': {
      const session = sessions.get(msg.id);
      if (session) {
        const decoded = Buffer.from(msg.data, 'base64').toString('utf-8');
        session.pty.write(decoded);
      }
      break;
    }

    case 'pty_resize': {
      const session = sessions.get(msg.id);
      if (session) {
        session.pty.resize(msg.cols, msg.rows);
      }
      break;
    }

    case 'pty_kill': {
      const session = sessions.get(msg.id);
      if (session) {
        session.pty.kill();
        sessions.delete(msg.id);
      }
      break;
    }

    case 'pty_attach': {
      const session = sessions.get(msg.id);
      if (session) {
        session.ws = ws;
        // Replay scrollback
        for (const chunk of session.scrollback) {
          send(ws, { type: 'pty_output', id: msg.id, data: chunk.toString('base64') });
        }
        // Resize to match client
        if (msg.cols && msg.rows) {
          session.pty.resize(msg.cols, msg.rows);
        }
        send(ws, { type: 'pty_started', id: msg.id });
      } else {
        // Session doesn't exist — tell client to create fresh
        send(ws, { type: 'pty_error', id: msg.id, error: 'Session not found' });
      }
      break;
    }
  }
}

export function detachWebSocket(ws: WebSocket) {
  for (const session of sessions.values()) {
    if (session.ws === ws) {
      session.ws = null;
    }
  }
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill();
  } catch {}
  sessions.delete(id);
  return true;
}

export function killDetachedExcept(keepIds: Set<string>): string[] {
  const killed: string[] = [];
  for (const [id, session] of sessions) {
    if (!keepIds.has(id) && session.ws === null) {
      try {
        session.pty.kill();
      } catch {}
      sessions.delete(id);
      killed.push(id);
    }
  }
  return killed;
}

export function killAllSessions() {
  for (const [id, session] of sessions) {
    try {
      session.pty.kill();
    } catch {}
    sessions.delete(id);
  }
}

export function getSessionIds(): string[] {
  return [...sessions.keys()];
}
