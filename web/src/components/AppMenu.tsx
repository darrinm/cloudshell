import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCRT } from '../hooks/useCRT';
import { THEME_META, type ThemePreference, useTheme } from '../hooks/useTheme';

interface AppMenuProps {
  authEnabled: boolean;
  onLogout: () => void;
}

export default function AppMenu({ authEnabled, onLogout }: AppMenuProps) {
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const { preference, setPreference } = useTheme();
  const { crtEnabled, setCRTEnabled } = useCRT();

  const updatePos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom, left: rect.left });
  }, []);

  // Position dropdown when opened
  useEffect(() => {
    if (!open) return;
    updatePos();
  }, [open, updatePos]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
      setThemeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setThemeOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleThemeSelect = (theme: ThemePreference) => {
    setPreference(theme);
    if (theme === 'phosphor' && !crtEnabled) {
      setCRTEnabled(true);
    }
    setOpen(false);
    setThemeOpen(false);
  };

  const handleLogout = async () => {
    setOpen(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    onLogout();
  };

  const dropdown =
    open &&
    createPortal(
      <div
        ref={dropdownRef}
        data-portal-phosphor
        className='fixed z-50 min-w-[180px] bg-iris-surface border border-iris-border rounded-lg shadow-float py-1'
        style={{ top: pos.top, left: pos.left }}
      >
        {/* Theme */}
        <div>
          <button
            onClick={() => setThemeOpen(!themeOpen)}
            className='w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-iris-text hover:bg-iris-surface-hover transition-colors'
          >
            <div className='flex items-center gap-2'>
              <svg
                className='w-4 h-4 text-iris-text-muted'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  d='M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z'
                />
              </svg>
              Theme
            </div>
            <svg
              className={`w-3 h-3 text-iris-text-faint transition-transform ${themeOpen ? 'rotate-90' : ''}`}
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M9 5l7 7-7 7' />
            </svg>
          </button>

          {/* Theme submenu */}
          {themeOpen && (
            <div className='py-1 border-t border-iris-border/50'>
              {THEME_META.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => handleThemeSelect(theme.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                    preference === theme.id
                      ? 'text-iris-primary bg-iris-primary/10'
                      : 'text-iris-text-secondary hover:bg-iris-surface-hover hover:text-iris-text'
                  }`}
                >
                  <span
                    className={`w-3 h-3 rounded-full border border-iris-border/50 shrink-0 ${
                      theme.id === 'system'
                        ? 'bg-gradient-to-br from-white to-gray-800'
                        : theme.id === 'light'
                          ? 'bg-white'
                          : ''
                    }`}
                    style={
                      theme.metaColor && theme.id !== 'light'
                        ? { backgroundColor: theme.metaColor }
                        : undefined
                    }
                  />
                  {theme.label}
                  {preference === theme.id && (
                    <svg
                      className='w-3 h-3 ml-auto text-iris-primary'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M5 13l4 4L19 7'
                      />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Retro CRT toggle */}
        <div className='h-px bg-iris-border/50 my-1' />
        <button
          onClick={() => {
            setCRTEnabled(!crtEnabled);
            setOpen(false);
          }}
          className='w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-iris-text-secondary hover:bg-iris-surface-hover hover:text-iris-text transition-colors'
        >
          <div className='flex items-center gap-2'>
            <svg
              className='w-4 h-4 text-iris-text-muted'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
              strokeWidth={1.5}
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25h-13.5A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z'
              />
            </svg>
            Retro CRT
          </div>
          {crtEnabled && (
            <svg
              className='w-3 h-3 text-iris-primary'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M5 13l4 4L19 7'
              />
            </svg>
          )}
        </button>

        {/* Logout — only when auth is enabled */}
        {authEnabled && (
          <>
            <div className='h-px bg-iris-border/50 my-1' />
            <button
              onClick={handleLogout}
              className='w-full flex items-center gap-2 px-3 py-2.5 text-sm text-iris-text-secondary hover:bg-iris-surface-hover hover:text-iris-text transition-colors'
            >
              <svg
                className='w-4 h-4 text-iris-text-muted'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  d='M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1'
                />
              </svg>
              Log out
            </button>
          </>
        )}
      </div>,
      document.body,
    );

  return (
    <div className='shrink-0'>
      <button
        ref={buttonRef}
        onClick={() => {
          setOpen(!open);
          if (open) setThemeOpen(false);
        }}
        className='flex items-center justify-center w-9 h-9 text-iris-text-secondary hover:text-iris-text hover:bg-iris-surface-hover transition-colors'
        title='Menu'
        aria-label='Menu'
      >
        <svg
          className='w-4 h-4'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth={1.5}
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <path d='M6.5 19h11a4.5 4.5 0 001.077-8.874A5.5 5.5 0 007.623 9.07 3.5 3.5 0 006.5 16H6a3 3 0 010-6' />
          <path d='M8 19v2m0 0h.01M12 19v2m0 0h.01M16 19v2m0 0h.01' />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}
