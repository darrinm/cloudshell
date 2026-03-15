import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TabSettings } from '../App';
import AppMenu from './AppMenu';
import { BUDGET_OPTIONS, EFFORT_OPTIONS, isAdvancedModel } from './ThinkingToggle';

export type TabType = 'terminal' | 'code' | 'work';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
}

const MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6' },
];

const SCROLL_THRESHOLD = 5;
const LONG_PRESS_MS = 500;

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  streamingTabIds: string[];
  authEnabled: boolean;
  tabSettings: Record<string, TabSettings>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (type: TabType) => void;
  onRenameTab: (id: string, title: string) => void;
  onReorderTabs: (orderedIds: string[]) => void;
  onUpdateTabSettings: (tabId: string, partial: Partial<TabSettings>) => void;
  onLogout: () => void;
}

function TabIcon({ type }: { type: TabType }) {
  switch (type) {
    case 'terminal':
      return (
        <svg
          className='w-3.5 h-3.5 text-iris-warning'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth={2}
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <polyline points='4 17 10 11 4 5' />
          <line x1='12' y1='19' x2='20' y2='19' />
        </svg>
      );
    case 'code':
      return (
        <svg className='w-[15px] h-[10px]' viewBox='0 0 12 8' shapeRendering='crispEdges'>
          <rect x='2' y='0' width='8' height='1' fill='#c27a4a' />
          <rect x='2' y='1' width='1' height='1' fill='#c27a4a' />
          <rect x='3' y='1' width='1' height='1' fill='#2a1f14' />
          <rect x='4' y='1' width='4' height='1' fill='#c27a4a' />
          <rect x='8' y='1' width='1' height='1' fill='#2a1f14' />
          <rect x='9' y='1' width='1' height='1' fill='#c27a4a' />
          <rect x='0' y='2' width='12' height='2' fill='#c27a4a' />
          <rect x='2' y='4' width='8' height='2' fill='#c27a4a' />
          <rect x='2' y='6' width='1' height='2' fill='#c27a4a' />
          <rect x='4' y='6' width='1' height='2' fill='#c27a4a' />
          <rect x='7' y='6' width='1' height='2' fill='#c27a4a' />
          <rect x='9' y='6' width='1' height='2' fill='#c27a4a' />
        </svg>
      );
    case 'work':
      return (
        <svg
          className='w-3.5 h-3.5 text-iris-thinking'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth={2}
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <path d='M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z' />
        </svg>
      );
  }
}

export default function TabBar({
  tabs,
  activeTabId,
  streamingTabIds,
  authEnabled,
  tabSettings,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onRenameTab,
  onReorderTabs,
  onUpdateTabSettings,
  onLogout,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState({ top: 0, left: 0 });
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragTabRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const newTabBtnRef = useRef<HTMLButtonElement>(null);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    startX: number;
    startY: number;
  } | null>(null);
  const contextMenuOpenedAtRef = useRef(0);

  const computeVisibleCount = useCallback(
    (containerWidth: number) => {
      if (tabs.length === 0) return 0;
      const isMobile = window.matchMedia('(max-width: 767px)').matches;
      const base = isMobile ? 44 : 63; // no close button on mobile
      const overflowBtnWidth = 40;
      let used = 0;
      let count = 0;
      for (let i = 0; i < tabs.length; i++) {
        const w = base + Math.min(tabs[i].title.length * 7, 120);
        const remaining = tabs.length - (i + 1);
        const needsOverflow = remaining > 0;
        if (used + w + (needsOverflow ? overflowBtnWidth : 0) > containerWidth) break;
        used += w;
        count++;
      }
      return Math.max(1, count);
    },
    [tabs],
  );

  // ResizeObserver to track container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setVisibleCount(computeVisibleCount(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeVisibleCount]);

  // Recompute when tabs change
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setVisibleCount(computeVisibleCount(el.clientWidth));
  }, [tabs, computeVisibleCount]);

  // Split tabs into visible and overflow, guaranteeing active tab is visible
  const { visibleTabs, overflowTabs } = useMemo(() => {
    if (visibleCount >= tabs.length) {
      return { visibleTabs: tabs, overflowTabs: [] as Tab[] };
    }
    const visible = tabs.slice(0, visibleCount);
    const overflow = tabs.slice(visibleCount);
    const activeInOverflowIdx = overflow.findIndex((t) => t.id === activeTabId);
    if (activeInOverflowIdx !== -1 && visible.length > 0) {
      const swapped = overflow[activeInOverflowIdx];
      const lastVisible = visible[visible.length - 1];
      visible[visible.length - 1] = swapped;
      overflow[activeInOverflowIdx] = lastVisible;
    }
    return { visibleTabs: visible, overflowTabs: overflow };
  }, [tabs, visibleCount, activeTabId]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (overflowBtnRef.current?.contains(target) || overflowMenuRef.current?.contains(target))
        return;
      setOverflowOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [overflowOpen]);

  // Close overflow menu on Escape
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [overflowOpen]);

  // Auto-close overflow menu when no overflow tabs remain
  useEffect(() => {
    if (overflowTabs.length === 0) setOverflowOpen(false);
  }, [overflowTabs.length]);

  // Close context menu on outside click (grace period to ignore synthetic mouse events from long-press)
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (Date.now() - contextMenuOpenedAtRef.current < 500) return;
      const target = e.target as Node;
      if (contextMenuRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [contextMenu]);

  // Close context menu on Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [contextMenu]);

  // Clamp context menu to viewport
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let { x, y } = contextMenu;
    if (rect.right > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (rect.bottom > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x, y } : null));
    }
  }, [contextMenu]);

  // Close new tab menu on outside click
  useEffect(() => {
    if (!newTabMenuOpen) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (newTabBtnRef.current?.contains(target) || newTabMenuRef.current?.contains(target)) return;
      setNewTabMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [newTabMenuOpen]);

  // Close new tab menu on Escape
  useEffect(() => {
    if (!newTabMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewTabMenuOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [newTabMenuOpen]);

  // Clamp new tab menu to viewport
  useLayoutEffect(() => {
    if (!newTabMenuOpen || !newTabMenuRef.current || !newTabBtnRef.current) return;
    const el = newTabMenuRef.current;
    const btn = newTabBtnRef.current.getBoundingClientRect();
    const pad = 8;
    let left = btn.left;
    let top = btn.bottom + 4;
    const rect = el.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = btn.top - rect.height - 4;
    if (left < pad) left = pad;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [newTabMenuOpen]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const openContextMenu = useCallback((tabId: string, x: number, y: number) => {
    contextMenuOpenedAtRef.current = Date.now();
    setContextMenu({ tabId, x, y });
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault();
      openContextMenu(tabId, e.clientX, e.clientY);
    },
    [openContextMenu],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, tabId: string) => {
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      const timer = setTimeout(() => {
        openContextMenu(tabId, startX, startY);
        longPressRef.current = null;
      }, LONG_PRESS_MS);
      longPressRef.current = { timer, startX, startY };
    },
    [openContextMenu],
  );

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!longPressRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - longPressRef.current.startX;
    const dy = touch.clientY - longPressRef.current.startY;
    if (Math.abs(dx) > SCROLL_THRESHOLD || Math.abs(dy) > SCROLL_THRESHOLD) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  }, []);

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    dragTabRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, dropTargetId: string) => {
    e.preventDefault();
    const draggedId = dragTabRef.current;
    dragTabRef.current = null;
    if (!draggedId || draggedId === dropTargetId) return;

    const ids = tabs.map((t) => t.id);
    const dragIdx = ids.indexOf(draggedId);
    const dropIdx = ids.indexOf(dropTargetId);
    if (dragIdx === -1 || dropIdx === -1) return;

    ids.splice(dragIdx, 1);
    ids.splice(dropIdx, 0, draggedId);
    onReorderTabs(ids);
  };

  // Resolve context menu tab info
  const contextTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : null;
  const contextSettings = contextMenu ? tabSettings[contextMenu.tabId] : null;

  return (
    <div
      data-tabbar
      className='flex items-center bg-iris-bg border-b border-iris-border h-10 select-none overflow-hidden'
    >
      <AppMenu authEnabled={authEnabled} onLogout={onLogout} />
      <div ref={containerRef} className='flex items-center min-w-0 flex-1'>
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            className={`group relative overflow-hidden flex items-center gap-1 px-3 h-10 text-sm cursor-pointer border-r border-iris-border-muted shrink-0 transition-colors duration-100 ${
              tab.id === activeTabId
                ? 'bg-iris-surface text-iris-text'
                : 'text-iris-text-secondary hover:bg-iris-surface-hover hover:text-iris-text'
            }`}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={() => {
              setEditingId(tab.id);
              setEditValue(tab.title);
            }}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            onTouchStart={(e) => handleTouchStart(e, tab.id)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            draggable
            onDragStart={(e) => handleDragStart(e, tab.id)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, tab.id)}
          >
            {streamingTabIds.includes(tab.id) && (
              <div className='absolute inset-0 overflow-hidden rounded-t-md pointer-events-none'>
                <div
                  className='absolute inset-0 -translate-x-full animate-[shimmer_2s_ease-in-out_infinite]'
                  style={{
                    background:
                      'linear-gradient(90deg, transparent 0%, rgba(148,163,184,0.08) 40%, rgba(148,163,184,0.15) 50%, rgba(148,163,184,0.08) 60%, transparent 100%)',
                  }}
                />
              </div>
            )}
            <TabIcon type={tab.type} />
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                className='bg-transparent border-none outline-none text-sm text-iris-text w-20'
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className='truncate max-w-[120px]'>{tab.title}</span>
            )}
            {
              <button
                className='ml-1 p-0.5 rounded text-iris-text-faint hover:text-iris-text hover:bg-iris-surface-active hidden md:inline-flex opacity-0 group-hover:opacity-100 transition-opacity'
                aria-label='Close tab'
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <svg className='w-3 h-3' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M6 18L18 6M6 6l12 12'
                  />
                </svg>
              </button>
            }
          </div>
        ))}
        {/* Overflow menu button — right after visible tabs */}
        {overflowTabs.length > 0 && (
          <button
            ref={overflowBtnRef}
            className='flex items-center gap-0.5 px-2 h-10 text-xs text-iris-text-secondary hover:text-iris-text hover:bg-iris-surface-hover transition-colors border-r border-iris-border-muted shrink-0'
            onClick={() => {
              if (!overflowBtnRef.current) return;
              const rect = overflowBtnRef.current.getBoundingClientRect();
              setOverflowPos({ top: rect.bottom, left: rect.left });
              setOverflowOpen(!overflowOpen);
            }}
            title={`${overflowTabs.length} more tab${overflowTabs.length > 1 ? 's' : ''}`}
            aria-label={`${overflowTabs.length} more tabs`}
          >
            <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='currentColor'>
              <circle cx='5' cy='12' r='2' />
              <circle cx='12' cy='12' r='2' />
              <circle cx='19' cy='12' r='2' />
            </svg>
            <span className='text-[10px] font-medium'>{overflowTabs.length}</span>
          </button>
        )}
      </div>
      {overflowOpen &&
        createPortal(
          <div
            ref={overflowMenuRef}
            data-portal-phosphor
            className='fixed z-50 min-w-[180px] max-w-[260px] bg-iris-surface border border-iris-border rounded-lg shadow-float py-1'
            style={{ top: overflowPos.top, left: overflowPos.left }}
          >
            {overflowTabs.map((tab) => (
              <div
                key={tab.id}
                className='group flex items-center gap-2 px-3 py-2.5 text-sm text-iris-text-secondary hover:bg-iris-surface-hover hover:text-iris-text transition-colors cursor-pointer'
                onClick={() => {
                  onSelectTab(tab.id);
                  setOverflowOpen(false);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setOverflowOpen(false);
                  openContextMenu(tab.id, e.clientX, e.clientY);
                }}
              >
                <TabIcon type={tab.type} />
                <span className='truncate flex-1'>{tab.title}</span>
                {streamingTabIds.includes(tab.id) && (
                  <span className='w-1.5 h-1.5 rounded-full bg-iris-primary animate-pulse shrink-0' />
                )}
                <button
                  className='p-0.5 rounded text-iris-text-faint hover:text-iris-text hover:bg-iris-surface-active opacity-0 group-hover:opacity-100 transition-opacity shrink-0'
                  aria-label='Close tab'
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <svg className='w-3 h-3' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M6 18L18 6M6 6l12 12'
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
      {/* Context menu portal */}
      {contextMenu &&
        contextTab &&
        createPortal(
          <div
            ref={contextMenuRef}
            data-portal-phosphor
            className='fixed z-[60] min-w-[200px] bg-iris-surface border border-iris-border rounded-lg shadow-float py-1'
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {contextTab.type === 'work' && contextSettings && (
              <>
                {/* Model section */}
                <div className='px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-iris-text-faint'>
                  Model
                </div>
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-iris-surface-hover transition-colors ${
                      contextSettings.model === m.id ? 'text-iris-text' : 'text-iris-text-secondary'
                    }`}
                    onClick={() => {
                      const partial: Partial<TabSettings> = { model: m.id };
                      // Clear thinking if new model doesn't support advanced mode
                      if (
                        contextSettings.thinkingEnabled &&
                        !isAdvancedModel(m.id) &&
                        isAdvancedModel(contextSettings.model)
                      ) {
                        partial.thinkingBudget = 10000;
                      }
                      onUpdateTabSettings(contextMenu.tabId, partial);
                    }}
                  >
                    <span className='w-4 text-center'>
                      {contextSettings.model === m.id ? '●' : '○'}
                    </span>
                    {m.name}
                  </button>
                ))}

                {/* Divider */}
                <div className='my-1 border-t border-iris-border' />

                {/* Thinking section */}
                <div className='px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-iris-text-faint'>
                  Thinking
                </div>
                <button
                  className='w-full px-3 py-1.5 text-left text-sm flex items-center justify-between hover:bg-iris-surface-hover transition-colors text-iris-text-secondary'
                  onClick={() =>
                    onUpdateTabSettings(contextMenu.tabId, {
                      thinkingEnabled: !contextSettings.thinkingEnabled,
                    })
                  }
                >
                  <span>Extended thinking</span>
                  <span
                    className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      contextSettings.thinkingEnabled
                        ? 'bg-iris-thinking/20 text-iris-thinking'
                        : 'bg-iris-surface-raised text-iris-text-faint'
                    }`}
                  >
                    {contextSettings.thinkingEnabled ? 'On' : 'Off'}
                  </span>
                </button>
                {contextSettings.thinkingEnabled && (
                  <div className='px-3 py-1'>
                    {isAdvancedModel(contextSettings.model) ? (
                      <div className='flex items-center gap-1'>
                        <span className='text-xs text-iris-text-faint mr-1'>Effort:</span>
                        {EFFORT_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                              contextSettings.thinkingEffort === opt.value
                                ? 'bg-iris-thinking/20 text-iris-thinking'
                                : 'text-iris-text-secondary hover:bg-iris-surface-hover'
                            }`}
                            onClick={() =>
                              onUpdateTabSettings(contextMenu.tabId, {
                                thinkingEffort: opt.value,
                              })
                            }
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className='flex items-center gap-1'>
                        <span className='text-xs text-iris-text-faint mr-1'>Budget:</span>
                        {BUDGET_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                              contextSettings.thinkingBudget === opt.value
                                ? 'bg-iris-thinking/20 text-iris-thinking'
                                : 'text-iris-text-secondary hover:bg-iris-surface-hover'
                            }`}
                            onClick={() =>
                              onUpdateTabSettings(contextMenu.tabId, {
                                thinkingBudget: opt.value,
                              })
                            }
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Divider */}
                <div className='my-1 border-t border-iris-border' />
              </>
            )}

            {/* Rename */}
            <button
              className='w-full px-3 py-1.5 text-left text-sm text-iris-text-secondary hover:bg-iris-surface-hover transition-colors'
              onClick={() => {
                setEditingId(contextMenu.tabId);
                setEditValue(contextTab.title);
                setContextMenu(null);
              }}
            >
              Rename
            </button>

            {/* Close */}
            <button
              className='w-full px-3 py-1.5 text-left text-sm text-iris-error hover:bg-iris-surface-hover transition-colors'
              onClick={() => {
                onCloseTab(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              Close
            </button>
          </div>,
          document.body,
        )}
      {/* Add tab buttons — desktop: 3 individual buttons, mobile: single + button with dropdown */}
      <div className='hidden md:flex items-center gap-0.5 px-2 shrink-0'>
        <button
          className='p-1.5 rounded hover:bg-iris-surface-hover transition-colors'
          onClick={() => onAddTab('work')}
          title='New Agent'
          aria-label='New Agent'
        >
          <TabIcon type='work' />
        </button>
        <button
          className='p-1.5 rounded hover:bg-iris-surface-hover transition-colors'
          onClick={() => onAddTab('code')}
          title='New Claude Code'
          aria-label='New Claude Code'
        >
          <TabIcon type='code' />
        </button>
        <button
          className='p-1.5 rounded hover:bg-iris-surface-hover transition-colors'
          onClick={() => onAddTab('terminal')}
          title='New Shell'
          aria-label='New Shell'
        >
          <TabIcon type='terminal' />
        </button>
      </div>
      <div className='md:hidden flex items-center px-1 shrink-0'>
        <button
          ref={newTabBtnRef}
          className='p-1.5 rounded hover:bg-iris-surface-hover transition-colors text-iris-text-secondary'
          onClick={() => setNewTabMenuOpen((prev) => !prev)}
          title='New tab'
          aria-label='New tab'
        >
          <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={1.5}
              d='M12 4v16m8-8H4'
            />
          </svg>
        </button>
      </div>
      {newTabMenuOpen &&
        createPortal(
          <div
            ref={newTabMenuRef}
            data-portal-phosphor
            className='fixed z-50 min-w-[160px] bg-iris-surface border border-iris-border rounded-lg shadow-float py-1'
          >
            <button
              className='w-full px-3 py-2 text-left text-sm text-iris-text-secondary hover:bg-iris-surface-hover transition-colors flex items-center gap-2'
              onClick={() => {
                onAddTab('work');
                setNewTabMenuOpen(false);
              }}
            >
              <TabIcon type='work' />
              New Agent
            </button>
            <button
              className='w-full px-3 py-2 text-left text-sm text-iris-text-secondary hover:bg-iris-surface-hover transition-colors flex items-center gap-2'
              onClick={() => {
                onAddTab('code');
                setNewTabMenuOpen(false);
              }}
            >
              <TabIcon type='code' />
              New Claude Code
            </button>
            <button
              className='w-full px-3 py-2 text-left text-sm text-iris-text-secondary hover:bg-iris-surface-hover transition-colors flex items-center gap-2'
              onClick={() => {
                onAddTab('terminal');
                setNewTabMenuOpen(false);
              }}
            >
              <TabIcon type='terminal' />
              New Shell
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
