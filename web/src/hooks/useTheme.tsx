import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

export type ThemePreference =
  | 'light'
  | 'dark'
  | 'system'
  | 'solarized-dark'
  | 'dracula'
  | 'monokai'
  | 'catppuccin'
  | 'gruvbox'
  | 'tokyo-night'
  | 'phosphor';
export type ResolvedTheme =
  | 'light'
  | 'dark'
  | 'solarized-dark'
  | 'dracula'
  | 'monokai'
  | 'catppuccin'
  | 'gruvbox'
  | 'tokyo-night'
  | 'phosphor';

export const THEME_META: {
  id: ThemePreference;
  label: string;
  metaColor: string;
  dark: boolean;
}[] = [
  { id: 'system', label: 'System', metaColor: '', dark: false },
  { id: 'light', label: 'Light', metaColor: '#ffffff', dark: false },
  { id: 'dark', label: 'Dark', metaColor: '#0a0a0a', dark: true },
  { id: 'phosphor', label: 'Phosphor', metaColor: '#050505', dark: true },
  { id: 'solarized-dark', label: 'Solarized Dark', metaColor: '#002b36', dark: true },
  { id: 'dracula', label: 'Dracula', metaColor: '#282a36', dark: true },
  { id: 'monokai', label: 'Monokai', metaColor: '#272822', dark: true },
  { id: 'catppuccin', label: 'Catppuccin', metaColor: '#1e1e2e', dark: true },
  { id: 'gruvbox', label: 'Gruvbox', metaColor: '#282828', dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', metaColor: '#1a1b26', dark: true },
];

const VALID_PREFS = new Set<string>(THEME_META.map((t) => t.id));
const META_COLOR_MAP = Object.fromEntries(
  THEME_META.filter((t) => t.id !== 'system').map((t) => [t.id, t.metaColor]),
);

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  resolved: 'dark',
  setPreference: () => {},
});

const STORAGE_KEY = 'iris-theme';

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLOR_MAP[resolved] || '#0a0a0a');
}

export function isDarkTheme(resolved: ResolvedTheme): boolean {
  return resolved !== 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_PREFS.has(stored)) return stored as ThemePreference;
    return 'system';
  });

  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  const setPreference = useCallback((pref: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, pref);
    setPreferenceState(pref);
    const next = resolveTheme(pref);
    setResolved(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      const next = getSystemTheme();
      setResolved(next);
      applyTheme(next);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference]);

  useEffect(() => {
    applyTheme(resolved);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
