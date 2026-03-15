import { FitAddon, Terminal, init as ghosttyInit } from 'ghostty-web';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useCRT } from '../hooks/useCRT';
import { IS_TOUCH, useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { useTheme } from '../hooks/useTheme';
import { WebGLRenderer } from './terminalRenderer';

interface TerminalTabProps {
  tabId: string;
  visible?: boolean;
  command?: string;
  cwd?: string;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'exited';

// Track sessions created in this page session
const createdSessions = new Set<string>();

/** Pre-populate session IDs so restored tabs attempt pty_attach first */
export function preloadSessions(ids: string[]): void {
  for (const id of ids) createdSessions.add(id);
}

/** Mobile toolbar — Tab, Esc, Ctrl, arrows, Ctrl-C, paste image */
function TerminalToolbar({
  onSend,
  ctrlActive,
  onCtrlToggle,
  onPasteImage,
}: {
  onSend: (bytes: string) => void;
  ctrlActive: boolean;
  onCtrlToggle: () => void;
  onPasteImage: () => void;
}) {
  const btn =
    'min-h-[36px] min-w-[36px] px-2.5 flex items-center justify-center text-iris-text text-sm font-mono rounded active:bg-iris-surface-raised select-none';
  const tap = (bytes: string) => (e: React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSend(bytes);
  };

  return (
    <div
      className='flex items-center gap-1 px-2 py-1.5 bg-iris-surface border-t border-iris-border overflow-x-auto'
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className={btn} onTouchStart={tap('\t')}>
        Tab
      </div>
      <div className={btn} onTouchStart={tap('\x1b')}>
        Esc
      </div>
      <div
        className={`${btn} ${ctrlActive ? 'bg-iris-primary/20 text-iris-primary' : ''}`}
        onTouchStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onCtrlToggle();
        }}
      >
        Ctrl
      </div>
      <div className='w-px h-5 bg-iris-border-muted mx-0.5' />
      <div className={btn} onTouchStart={tap('\x1b[A')}>
        &#x2191;
      </div>
      <div className={btn} onTouchStart={tap('\x1b[B')}>
        &#x2193;
      </div>
      <div className={btn} onTouchStart={tap('\x1b[D')}>
        &#x2190;
      </div>
      <div className={btn} onTouchStart={tap('\x1b[C')}>
        &#x2192;
      </div>
      <div className='w-px h-5 bg-iris-border-muted mx-0.5' />
      <div
        className={btn}
        onTouchStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onPasteImage();
        }}
      >
        <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
          <path
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={1.5}
            d='M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13'
          />
        </svg>
      </div>
      <div className={`${btn} text-iris-error`} onTouchStart={tap('\x03')}>
        ^C
      </div>
    </div>
  );
}

// SGR reset workaround — ghostty-web's ESC[0m resets to white bg, not the theme bg.
const SGR_RESET = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]); // ESC[0m
let sgrResetReplacement: Uint8Array | null = null;

function patchSgrResets(src: Uint8Array): Uint8Array {
  if (!sgrResetReplacement) return src;
  const repl = sgrResetReplacement;
  const positions: number[] = [];
  for (let i = 0; i <= src.length - 4; i++) {
    if (src[i] === 0x1b && src[i + 1] === 0x5b && src[i + 2] === 0x30 && src[i + 3] === 0x6d) {
      positions.push(i);
    }
  }
  if (positions.length === 0) return src;
  const extra = repl.length - SGR_RESET.length;
  const out = new Uint8Array(src.length + positions.length * extra);
  let si = 0,
    di = 0;
  for (const pos of positions) {
    const chunk = src.subarray(si, pos);
    out.set(chunk, di);
    di += chunk.length;
    out.set(repl, di);
    di += repl.length;
    si = pos + SGR_RESET.length;
  }
  const tail = src.subarray(si);
  out.set(tail, di);
  di += tail.length;
  return out.subarray(0, di);
}

function safeTermWrite(term: Terminal, data: Uint8Array) {
  const cleaned = patchSgrResets(data);
  const CHUNK = 8 * 1024;
  if (cleaned.length <= CHUNK) {
    term.write(cleaned);
    return;
  }
  let pos = 0;
  while (pos < cleaned.length) {
    let end = Math.min(pos + CHUNK, cleaned.length);
    if (end < cleaned.length) {
      let splitAt = -1;
      for (let i = end - 1; i > pos; i--) {
        if (cleaned[i] === 0x0a) {
          splitAt = i + 1;
          break;
        }
      }
      if (splitAt > pos) {
        end = splitAt;
      } else {
        for (let i = end - 1; i > pos; i--) {
          if (cleaned[i] === 0x1b) {
            end = i;
            break;
          }
        }
      }
    }
    try {
      term.write(cleaned.subarray(pos, end));
    } catch (e) {
      console.warn('[TerminalTab] write failed, truncating:', e);
      break;
    }
    pos = end;
  }
}

const ANSI_COLORS = {
  black: '#09090b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
};

function rgbVarToHex(varName: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!val) return '#000000';
  const parts = val.split(/\s+/).map(Number);
  return '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('');
}

function getAnsiColors(): typeof ANSI_COLORS {
  const style = getComputedStyle(document.documentElement);
  const probe = style.getPropertyValue('--iris-ansi-black').trim();
  if (!probe) return ANSI_COLORS;
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    black: read('--iris-ansi-black'),
    red: read('--iris-ansi-red'),
    green: read('--iris-ansi-green'),
    yellow: read('--iris-ansi-yellow'),
    blue: read('--iris-ansi-blue'),
    magenta: read('--iris-ansi-magenta'),
    cyan: read('--iris-ansi-cyan'),
    white: read('--iris-ansi-white'),
    brightBlack: read('--iris-ansi-brightBlack'),
    brightRed: read('--iris-ansi-brightRed'),
    brightGreen: read('--iris-ansi-brightGreen'),
    brightYellow: read('--iris-ansi-brightYellow'),
    brightBlue: read('--iris-ansi-brightBlue'),
    brightMagenta: read('--iris-ansi-brightMagenta'),
    brightCyan: read('--iris-ansi-brightCyan'),
    brightWhite: read('--iris-ansi-brightWhite'),
  };
}

function buildTheme() {
  const bg = rgbVarToHex('--iris-bg');
  const fg = rgbVarToHex('--iris-text');
  const sel = rgbVarToHex('--iris-surface-active');
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: sel,
    ...getAnsiColors(),
  };
}

function updateSgrReset() {
  const bg = rgbVarToHex('--iris-bg');
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  sgrResetReplacement = new TextEncoder().encode(`\x1b[0;48;2;${r};${g};${b}m`);
}

export default function TerminalTab({ tabId, visible, command, cwd }: TerminalTabProps) {
  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitedRef = useRef(false);
  const visibleRef = useRef(visible ?? true);
  const pendingWritesRef = useRef<Uint8Array[]>([]);
  const writeBatchRef = useRef<Uint8Array[]>([]);
  const lastInputTimeRef = useRef(0);
  const didPreFitRef = useRef(false);
  const origRendererRef = useRef<unknown>(null);
  const origCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglRendererRef = useRef<unknown>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const { resolved: resolvedTheme } = useTheme();
  const { crtEnabled } = useCRT();
  const crtEnabledRef = useRef(crtEnabled);
  crtEnabledRef.current = crtEnabled;

  // Mobile touch state
  const keyboardHeight = useKeyboardHeight();
  const ctrlActiveRef = useRef(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [pastingImage, setPastingImage] = useState(false);
  const pasteImageRef = useRef<(() => void) | null>(null);

  const keyboardVisible = IS_TOUCH && keyboardHeight > 0;

  // Send raw bytes to PTY via WebSocket
  const sendBytes = useCallback(
    (bytes: string) => {
      if (ctrlActiveRef.current) {
        ctrlActiveRef.current = false;
        setCtrlActive(false);
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const utf8 = new TextEncoder().encode(bytes);
        ws.send(
          JSON.stringify({
            type: 'pty_input',
            id: tabId,
            data: btoa(String.fromCharCode(...utf8)),
          }),
        );
      }
      termRef.current?.focus();
    },
    [tabId],
  );

  const toggleCtrl = useCallback(() => {
    ctrlActiveRef.current = !ctrlActiveRef.current;
    setCtrlActive(ctrlActiveRef.current);
    termRef.current?.focus();
  }, []);

  // Flush pending writes when tab becomes visible
  useEffect(() => {
    visibleRef.current = visible ?? true;
    if (visibleRef.current && pendingWritesRef.current.length > 0) {
      writeBatchRef.current.push(...pendingWritesRef.current);
      pendingWritesRef.current = [];
    }
    if (visibleRef.current) {
      fitAddonRef.current?.fit();
      if (!IS_TOUCH) termRef.current?.focus();
    }
  }, [visible]);

  const connect = useCallback(() => {
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) return;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/pty`);
    wsRef.current = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
        setConnectionState('disconnected');
        setError('Connection timed out');
        reconnectTimer.current = setTimeout(() => connect(), 3000);
      }
    }, 10_000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      const term = termRef.current;
      const cols = term?.cols || 80;
      const rows = term?.rows || 24;
      if (createdSessions.has(tabId)) {
        // Reconnect — attach to existing session with scrollback replay
        ws.send(JSON.stringify({ type: 'pty_attach', id: tabId, cols, rows }));
      } else {
        ws.send(
          JSON.stringify({
            type: 'pty_create',
            id: tabId,
            cols,
            rows,
            ...(command ? { command } : {}),
            ...(cwd ? { cwd } : {}),
          }),
        );
      }
    };

    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.id !== tabId) return; // ignore messages for other tabs

      switch (msg.type) {
        case 'pty_started':
          setConnectionState('connected');
          setError(null);
          createdSessions.add(tabId);
          {
            const term = termRef.current;
            if (term && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({ type: 'pty_resize', id: tabId, cols: term.cols, rows: term.rows }),
              );
            }
          }
          fitAddonRef.current?.fit();
          didPreFitRef.current = true;
          if (!IS_TOUCH) termRef.current?.focus();
          break;

        case 'pty_output': {
          const data = msg.data as string;
          if (data && termRef.current) {
            const bin = atob(data);
            const raw = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
            if (!visibleRef.current) {
              pendingWritesRef.current.push(raw);
              const MAX_BUFFER = 2 * 1024 * 1024;
              let bufSize = pendingWritesRef.current.reduce((s, c) => s + c.length, 0);
              while (bufSize > MAX_BUFFER && pendingWritesRef.current.length > 1) {
                bufSize -= pendingWritesRef.current.shift()!.length;
              }
              break;
            }
            writeBatchRef.current.push(raw);
          }
          break;
        }

        case 'pty_exit': {
          exitedRef.current = true;
          setConnectionState('exited');
          setExitCode((msg.exitCode as number) ?? null);
          break;
        }

        case 'pty_error': {
          // If attach failed (session not found), create fresh
          if (createdSessions.has(tabId) && (msg.error as string)?.includes('Session not found')) {
            createdSessions.delete(tabId);
            ws.send(
              JSON.stringify({
                type: 'pty_create',
                id: tabId,
                cols: termRef.current?.cols || 80,
                rows: termRef.current?.rows || 24,
                ...(command ? { command } : {}),
                ...(cwd ? { cwd } : {}),
              }),
            );
            break;
          }
          setError(msg.error as string);
          setConnectionState('disconnected');
          break;
        }
      }
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (!exitedRef.current) {
        setConnectionState('disconnected');
        reconnectTimer.current = setTimeout(() => connect(), 3000);
      }
    };

    ws.onerror = () => {
      /* onclose fires after */
    };
  }, [tabId, command, cwd]);

  // Update theme on change
  useEffect(() => {
    const theme = buildTheme();
    updateSgrReset();

    // Update WebGL renderer
    const webgl = webglRendererRef.current as {
      setTheme?: (t: typeof theme) => void;
      setPhosphor?: (e: boolean) => void;
    } | null;
    if (webgl?.setTheme) {
      webgl.setTheme(theme);
    }
    if (webgl?.setPhosphor) {
      webgl.setPhosphor(resolvedTheme === 'phosphor');
    }

    // Update the terminal container background
    if (termContainerRef.current) {
      const canvas = termContainerRef.current.querySelector('canvas');
      if (canvas) canvas.style.backgroundColor = theme.background;
    }

    // Force a full re-render
    const term = termRef.current as any;
    if (term?.wasmTerm && term.renderer) {
      // Send a SGR reset so existing text gets the new bg
      term.renderer.render?.(term.wasmTerm, true, term.viewportY, term, term.scrollbarOpacity);
    }
  }, [resolvedTheme]);

  // Propagate CRT state to WebGL renderer
  useEffect(() => {
    const webgl = webglRendererRef.current as { setCRTEnabled?: (e: boolean) => void } | null;
    if (webgl?.setCRTEnabled) {
      webgl.setCRTEnabled(crtEnabled);
    }
  }, [crtEnabled]);

  // Initialize terminal
  useEffect(() => {
    if (!termContainerRef.current) return;
    let disposed = false;
    let linkModifierCleanup: (() => void) | null = null;
    let touchCleanup: (() => void) | null = null;
    let pasteCleanup: (() => void) | null = null;

    async function setup() {
      await ghosttyInit();
      if (disposed || !termContainerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        scrollback: 5_000_000,
        smoothScrollDuration: 0,
        theme: buildTheme(),
      });

      updateSgrReset();

      const fitAddon = new FitAddon();
      // Override proposeDimensions to not subtract scrollbar width
      const origPropose = fitAddon.proposeDimensions.bind(fitAddon);
      fitAddon.proposeDimensions = () => {
        const dims = origPropose();
        if (!dims) return dims;
        const renderer = (
          term as unknown as { renderer: { getMetrics: () => { width: number; height: number } } }
        ).renderer;
        if (renderer?.getMetrics) {
          const metrics = renderer.getMetrics();
          if (metrics.width > 0) {
            const el = (term as unknown as { element: HTMLElement }).element;
            if (el) {
              const style = window.getComputedStyle(el);
              const padL = parseInt(style.paddingLeft) || 0;
              const padR = parseInt(style.paddingRight) || 0;
              dims.cols = Math.max(2, Math.floor((el.clientWidth - padL - padR) / metrics.width));
            }
          }
        }
        return dims;
      };
      term.loadAddon(fitAddon);
      term.open(termContainerRef.current!);

      // Intercept Cmd+R
      termContainerRef.current!.addEventListener(
        'keydown',
        (e) => {
          if ((e.metaKey || e.ctrlKey) && e.code === 'KeyR') e.stopPropagation();
        },
        true,
      );

      // WebGL renderer setup
      {
        const canvas = termContainerRef.current!.querySelector('canvas')!;
        const t = term as any;
        origRendererRef.current = t.renderer;
        origCanvasRef.current = canvas;
        const preferCanvas = localStorage.getItem('iris:renderer') === 'canvas';

        const origGetBCR = canvas.getBoundingClientRect.bind(canvas);
        canvas.getBoundingClientRect = () => {
          const active = termContainerRef.current?.querySelector('canvas');
          return active && active !== canvas ? active.getBoundingClientRect() : origGetBCR();
        };

        const webglRenderer = WebGLRenderer.create(canvas, {
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
          cursorStyle: 'block',
          cursorBlink: true,
          theme: buildTheme(),
        });
        if (webglRenderer) {
          const origRenderFn = (origRendererRef.current as any).render;
          if (origRenderFn && !(origRenderFn as any).__wrapped) {
            const bound = origRenderFn.bind(origRendererRef.current);
            const wrapped = (...args: unknown[]) => {
              try {
                return bound(...args);
              } catch (e) {
                console.warn('[TerminalTab] canvas render error:', e);
              }
            };
            (wrapped as any).__wrapped = true;
            (origRendererRef.current as any).render = wrapped;
          }
          webglRendererRef.current = webglRenderer;
          webglCanvasRef.current = termContainerRef.current!.querySelector('canvas')!;

          // Apply persisted CRT state now that the renderer exists
          if (crtEnabledRef.current) {
            webglRenderer.setCRTEnabled(true, false);
          }
          // Apply phosphor green filter if active
          webglRenderer.setPhosphor(
            document.documentElement.getAttribute('data-theme') === 'phosphor',
          );

          if (preferCanvas) {
            webglCanvasRef.current.parentElement?.replaceChild(canvas, webglCanvasRef.current);
            t.renderer = origRendererRef.current;
          } else {
            t.renderer = webglRenderer;
            if (t.selectionManager) {
              webglRenderer.setSelectionManager(t.selectionManager);
              t.selectionManager.renderer = webglRenderer;
              t.selectionManager.dispose();
              t.selectionManager.attachEventListeners();
            }
            const textarea = termContainerRef.current!.querySelector('textarea');
            if (textarea) {
              webglCanvasRef.current.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault();
                textarea.focus();
              });
            }
          }
        }
      }

      // Link modifier gating (Cmd+hover)
      {
        const t = term as any;
        const origProcessMouseMove = t.processMouseMove.bind(t);
        let lastMouseEvent: MouseEvent | null = null;

        t.processMouseMove = (event: MouseEvent) => {
          lastMouseEvent = event;
          if (event.metaKey || event.ctrlKey) {
            origProcessMouseMove(event);
          } else if (t.currentHoveredLink) {
            t.currentHoveredLink.hover?.(false);
            t.currentHoveredLink = undefined;
            if (t.element) t.element.style.cursor = 'text';
            t.renderer?.setHoveredLinkRange?.(null);
          }
        };

        const onKeyDown = (e: KeyboardEvent) => {
          if ((e.key === 'Meta' || e.key === 'Control') && lastMouseEvent)
            origProcessMouseMove(lastMouseEvent);
        };
        const onKeyUp = (e: KeyboardEvent) => {
          if (e.key === 'Meta' || e.key === 'Control') {
            if (t.currentHoveredLink) {
              t.currentHoveredLink.hover?.(false);
              t.currentHoveredLink = undefined;
              if (t.element) t.element.style.cursor = 'text';
              t.renderer?.setHoveredLinkRange?.(null);
            }
          }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        linkModifierCleanup = () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('keyup', onKeyUp);
        };
      }

      // Fix cell metrics
      const rendererAny = term.renderer as unknown as {
        measureFont: () => { width: number; height: number; baseline: number };
        remeasureFont: () => void;
        fontSize: number;
        fontFamily: string;
      };
      if (rendererAny) {
        rendererAny.measureFont = () => {
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.font = `${rendererAny.fontSize}px ${rendererAny.fontFamily}`;
          const tm = ctx.measureText('M');
          const ascent =
            tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? rendererAny.fontSize * 0.8;
          const descent =
            tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? rendererAny.fontSize * 0.2;
          return {
            width: tm.width,
            height: Math.ceil(ascent + descent),
            baseline: Math.ceil(ascent),
          };
        };
        rendererAny.remeasureFont();
      }

      // Optimized render loop
      {
        const t = term as any;
        if (t.wasmTerm && t.renderer) {
          const origRender = t.renderer.render.bind(t.renderer);
          t.renderer.render = (...args: unknown[]) => {
            try {
              return origRender(...args);
            } catch (e) {
              console.warn('[TerminalTab] render error:', e);
            }
          };

          if (t.animationFrameId) {
            cancelAnimationFrame(t.animationFrameId);
            t.animationFrameId = undefined;
          }
          let lastCursorVisible = t.renderer.cursorVisible;
          let lastViewportY = 0;
          t.startRenderLoop = function () {
            const renderLoop = () => {
              if (t.isDisposed || !t.isOpen) return;
              try {
                let hadWrites = false;
                const chunks = writeBatchRef.current;
                if (chunks.length > 0) {
                  hadWrites = true;
                  writeBatchRef.current = [];
                  const totalLen = chunks.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
                  const merged = new Uint8Array(totalLen);
                  let offset = 0;
                  for (const chunk of chunks) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                  }

                  if (!didPreFitRef.current && totalLen > 10000) {
                    didPreFitRef.current = true;
                    fitAddonRef.current?.fit();
                  }

                  const savedViewportY = t.viewportY;
                  safeTermWrite(t, merged);
                  const recentInput = Date.now() - lastInputTimeRef.current < 500;
                  if (savedViewportY > 0 && !recentInput) t.viewportY = savedViewportY;
                }

                t.processTerminalResponses?.();
                const dirty = t.wasmTerm.update();
                const cv = t.renderer.cursorVisible;
                const blinkChanged = cv !== lastCursorVisible;
                lastCursorVisible = cv;
                const vpChanged = t.viewportY !== lastViewportY;
                lastViewportY = t.viewportY;
                const selDirty = t.selectionManager?.getDirtySelectionRows()?.size > 0;

                const crtActive = (t.renderer as any).crtActive;
                if (hadWrites || dirty > 0 || blinkChanged || vpChanged || selDirty || crtActive) {
                  t.renderer.render(t.wasmTerm, true, t.viewportY, t, t.scrollbarOpacity);
                  t.wasmTerm.markClean?.();
                  const cursor = t.wasmTerm.getCursor();
                  if (cursor.y !== t.lastCursorY) {
                    t.lastCursorY = cursor.y;
                    t.cursorMoveEmitter.fire();
                  }
                }
              } catch (e) {
                console.warn('[TerminalTab] render loop error:', e);
              }
              t.animationFrameId = requestAnimationFrame(renderLoop);
            };
            renderLoop();
          };
          t.startRenderLoop();
        }
      }

      // Key handling
      const termAny = term as any;
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        const ws = wsRef.current;
        const canSend = ws && ws.readyState === WebSocket.OPEN;

        // Cmd+C with selection → copy
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.code === 'KeyC') {
          if (typeof termAny.hasSelection === 'function' && termAny.hasSelection()) {
            const text = termAny.getSelection?.() as string;
            if (text) {
              navigator.clipboard.writeText(text).catch(() => {});
              return true;
            }
          }
          return false;
        }

        // Ctrl sticky modifier from toolbar
        if (
          ctrlActiveRef.current &&
          e.type === 'keydown' &&
          e.key.length === 1 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          if (canSend) {
            const ctrlByte = e.key.toLowerCase().charCodeAt(0) & 0x1f;
            ws!.send(
              JSON.stringify({
                type: 'pty_input',
                id: tabId,
                data: btoa(String.fromCharCode(ctrlByte)),
              }),
            );
          }
          ctrlActiveRef.current = false;
          setCtrlActive(false);
          return true;
        }

        // Shift-Tab
        if (e.key === 'Tab' && e.shiftKey) {
          if (e.type === 'keydown' && canSend) {
            e.preventDefault();
            const utf8 = new TextEncoder().encode('\x1b[9;2u');
            ws!.send(
              JSON.stringify({
                type: 'pty_input',
                id: tabId,
                data: btoa(String.fromCharCode(...utf8)),
              }),
            );
          }
          return true;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          return false;
        }

        // Option+key → ESC+key
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
          if (e.type === 'keydown' && canSend) {
            e.preventDefault();
            const utf8 = new TextEncoder().encode('\x1b' + e.key);
            ws!.send(
              JSON.stringify({
                type: 'pty_input',
                id: tabId,
                data: btoa(String.fromCharCode(...utf8)),
              }),
            );
          }
          return true;
        }

        return false;
      });

      await new Promise((r) => requestAnimationFrame(r));
      if (disposed) return;
      fitAddon.fit();
      fitAddon.observeResize();
      if (!IS_TOUCH) term.focus();

      // Hide ghostty-web's textarea caret
      const textarea = termContainerRef.current?.querySelector('textarea');
      if (textarea) {
        textarea.style.caretColor = 'transparent';

        if (IS_TOUCH) {
          textarea.setAttribute('autocorrect', 'on');
          textarea.setAttribute('autocomplete', 'off');
          textarea.spellcheck = false;
          textarea.style.width = '100%';
          textarea.style.height = '100%';
          textarea.style.opacity = '1';
          textarea.style.color = 'transparent';
          textarea.style.background = 'transparent';
          textarea.style.border = 'none';
          textarea.style.outline = 'none';
          textarea.style.resize = 'none';
          textarea.style.caretColor = 'transparent';
          textarea.style.zIndex = '1';
          textarea.style.clipPath = 'none';
          textarea.addEventListener('beforeinput', (e) => e.stopPropagation());

          // Remove contenteditable from container (shows iOS blue caret)
          termContainerRef.current?.removeAttribute('contenteditable');

          // Gate textarea.focus() — only explicit term.focus() calls can open
          // the keyboard. Ghostty-web's internal code (pointer events, render
          // callbacks) is silently blocked to prevent scroll-into-view issues.
          const origFocus = textarea.focus.bind(textarea);
          let focusAllowed = false;
          textarea.focus = () => {
            if (focusAllowed) {
              focusAllowed = false;
              origFocus();
            }
          };
          term.focus = () => {
            focusAllowed = true;
            textarea.focus();
          };
        }

        // Image paste support
        const sendImageBlob = (imgBlob: Blob) => {
          setPastingImage(true);
          imgBlob
            .arrayBuffer()
            .then((buffer) => {
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i += 8192) {
                binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
              }
              const base64 = btoa(binary);
              const ws = wsRef.current;
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pty_image_paste', id: tabId, data: base64 }));
                setTimeout(() => setPastingImage(false), 3000);
              } else {
                setPastingImage(false);
              }
            })
            .catch(() => setPastingImage(false));
        };

        pasteImageRef.current = () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.style.display = 'none';
          input.onchange = () => {
            const file = input.files?.[0];
            if (file) sendImageBlob(file);
            input.remove();
          };
          document.body.appendChild(input);
          input.click();
        };

        // Paste handler
        const handlePaste = (e: Event) => {
          if (!visibleRef.current) return;
          const clipEvent = e as ClipboardEvent;
          const cd = clipEvent.clipboardData;
          let blob: File | null = null;
          if (cd?.files?.length) {
            for (const file of Array.from(cd.files)) {
              if (file.type.startsWith('image/')) {
                blob = file;
                break;
              }
            }
          }
          if (!blob && cd?.items) {
            for (let i = 0; i < cd.items.length; i++) {
              if (cd.items[i].type.startsWith('image/')) {
                blob = cd.items[i].getAsFile();
                break;
              }
            }
          }
          if (blob) {
            clipEvent.preventDefault();
            sendImageBlob(blob);
          }
        };
        document.addEventListener('paste', handlePaste, true);
        pasteCleanup = () => document.removeEventListener('paste', handlePaste, true);
      }

      // Send input to PTY
      term.onData((data: string) => {
        lastInputTimeRef.current = Date.now();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const utf8 = new TextEncoder().encode(data);
          let binary = '';
          for (let i = 0; i < utf8.length; i += 8192) {
            binary += String.fromCharCode(...utf8.subarray(i, i + 8192));
          }
          ws.send(JSON.stringify({ type: 'pty_input', id: tabId, data: btoa(binary) }));
        }
      });

      // Resize handler
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty_resize', id: tabId, cols, rows }));
        }
      });

      // --- Touch handlers for mobile (scroll + tap-to-focus) ---
      if (IS_TOUCH && termContainerRef.current) {
        const container = termContainerRef.current;
        const SCROLL_THRESHOLD = 5;

        let touchStartX = 0;
        let touchStartY = 0;
        let touchLastY = 0;
        let scrolling = false;

        const termAny = term as any;

        const getLineHeight = (): number => {
          const renderer = (
            term as unknown as { renderer: { getMetrics: () => { height: number } } }
          ).renderer;
          return renderer?.getMetrics?.()?.height || 16;
        };

        const handleTouchStart = (e: TouchEvent) => {
          e.preventDefault();
          const touch = e.touches[0];
          touchStartX = touch.clientX;
          touchStartY = touch.clientY;
          touchLastY = touch.clientY;
          scrolling = false;
        };

        const handleTouchMove = (e: TouchEvent) => {
          const touch = e.touches[0];

          if (!scrolling) {
            const totalDist = Math.max(
              Math.abs(touch.clientX - touchStartX),
              Math.abs(touch.clientY - touchStartY),
            );
            if (totalDist > SCROLL_THRESHOLD) {
              scrolling = true;
            }
          }

          if (scrolling) {
            e.preventDefault();
            const deltaY = touch.clientY - touchLastY;
            const lineHeight = getLineHeight();
            const lines = Math.round(-deltaY / lineHeight);
            if (lines !== 0 && typeof termAny.scrollLines === 'function') {
              termAny.scrollLines(lines);
              touchLastY = touch.clientY;
            }
          }
        };

        const handleTouchEnd = (e: TouchEvent) => {
          if (scrolling) {
            e.preventDefault();
            scrolling = false;
            return;
          }

          // Short tap — focus textarea to open keyboard
          const endTouch = e.changedTouches[0];
          const tapDist = Math.max(
            Math.abs(endTouch.clientX - touchStartX),
            Math.abs(endTouch.clientY - touchStartY),
          );
          if (tapDist < SCROLL_THRESHOLD) {
            term.focus();
          }
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: false });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: false });

        touchCleanup = () => {
          container.removeEventListener('touchstart', handleTouchStart);
          container.removeEventListener('touchmove', handleTouchMove);
          container.removeEventListener('touchend', handleTouchEnd);
        };
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      connect();
    }

    setup();

    return () => {
      disposed = true;
      linkModifierCleanup?.();
      touchCleanup?.();
      pasteCleanup?.();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      termRef.current?.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restart handler
  const restart = useCallback(() => {
    exitedRef.current = false;
    createdSessions.delete(tabId);
    setConnectionState('connecting');
    setExitCode(null);
    setError(null);
    termRef.current?.clear();
    connect();
  }, [tabId, connect]);

  return (
    <div className='flex flex-col h-full bg-iris-bg'>
      {/* Connection status overlay */}
      {connectionState !== 'connected' && connectionState !== 'connecting' && (
        <div className='absolute inset-0 z-10 flex items-center justify-center bg-iris-bg/80 backdrop-blur-sm'>
          <div className='text-center'>
            {connectionState === 'exited' ? (
              <>
                <p className='text-iris-text-secondary mb-2'>
                  Session exited{exitCode !== null ? ` (code ${exitCode})` : ''}
                </p>
                <button
                  onClick={restart}
                  className='px-4 py-2 bg-iris-primary text-iris-primary-text rounded-lg hover:opacity-90 transition-opacity'
                >
                  Restart
                </button>
              </>
            ) : (
              <>
                <p className='text-iris-text-secondary mb-2'>{error || 'Disconnected'}</p>
                <p className='text-iris-text-muted text-sm'>Reconnecting...</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Pasting image indicator */}
      {pastingImage && (
        <div className='absolute top-2 right-2 z-10 px-3 py-1.5 bg-iris-surface rounded-lg text-iris-text-secondary text-sm border border-iris-border'>
          Pasting image...
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={termContainerRef}
        className='flex-1 min-h-0 p-1'
        style={
          keyboardVisible
            ? { height: `calc(100% - ${keyboardHeight + 48}px)`, flex: 'none' }
            : undefined
        }
      />

      {/* Mobile toolbar */}
      {keyboardVisible && (
        <div style={{ position: 'fixed', bottom: keyboardHeight, left: 0, right: 0, zIndex: 20 }}>
          <TerminalToolbar
            onSend={sendBytes}
            ctrlActive={ctrlActive}
            onCtrlToggle={toggleCtrl}
            onPasteImage={() => pasteImageRef.current?.()}
          />
        </div>
      )}
    </div>
  );
}
