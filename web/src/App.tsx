import { useCallback, useEffect, useRef, useState } from 'react';

import LoginPage from './components/LoginPage';
import TabBar, { type Tab, type TabType } from './components/TabBar';
import TerminalTab, { preloadSessions } from './components/TerminalTab';
import WorkTab from './components/WorkTab';
import { authFetch } from './lib/authFetch';
import { clearStream, getStream, useStreamingTabIds } from './lib/streamingStore';
import {
  fetchTabs,
  serverCreateTab,
  serverDeleteTab,
  serverRenameTab,
  serverReorderTabs,
} from './lib/tabPersistence';

const ACTIVE_TAB_KEY = 'cloudshell:activeTabId';

export interface TabSettings {
  model: string;
  thinkingEnabled: boolean;
  thinkingBudget: number;
  thinkingEffort: string;
}

const DEFAULT_TAB_SETTINGS: TabSettings = {
  model: 'claude-opus-4-6',
  thinkingEnabled: false,
  thinkingBudget: 10000,
  thinkingEffort: 'high',
};

type AuthState = 'loading' | 'authenticated' | 'unauthenticated';
type AuthMode = 'github' | 'password' | 'none';

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [authEnabled, setAuthEnabled] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>('none');

  useEffect(() => {
    fetch('/api/auth/check')
      .then((r) => r.json())
      .then((data) => {
        setAuthEnabled(data.authEnabled);
        setAuthMode(data.authMode || (data.authEnabled ? 'password' : 'none'));
        setAuthState(data.authenticated ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => setAuthState('unauthenticated'));
  }, []);

  // Listen for 401s from authFetch
  useEffect(() => {
    const handler = () => setAuthState('unauthenticated');
    window.addEventListener('cloudshell:auth-expired', handler);
    return () => window.removeEventListener('cloudshell:auth-expired', handler);
  }, []);

  if (authState === 'loading') {
    return (
      <div className='flex items-center justify-center h-screen bg-iris-bg text-iris-text-muted'>
        Loading...
      </div>
    );
  }

  if (authState === 'unauthenticated' && authEnabled) {
    return (
      <LoginPage
        authMode={authMode as 'github' | 'password'}
        onSuccess={() => setAuthState('authenticated')}
      />
    );
  }

  return <AppContent authEnabled={authEnabled} onLogout={() => setAuthState('unauthenticated')} />;
}

function AppContent({ authEnabled, onLogout }: { authEnabled: boolean; onLogout: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [loading, setLoading] = useState(true);
  const streamingTabIds = useStreamingTabIds();
  const [tabSettings, setTabSettings] = useState<Record<string, TabSettings>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const updateTabSettings = useCallback((tabId: string, partial: Partial<TabSettings>) => {
    setTabSettings((prev) => ({
      ...prev,
      [tabId]: { ...(prev[tabId] ?? DEFAULT_TAB_SETTINGS), ...partial },
    }));
  }, []);

  const getTabSettings = useCallback(
    (tabId: string): TabSettings => tabSettings[tabId] ?? DEFAULT_TAB_SETTINGS,
    [tabSettings],
  );

  // Load tabs from server on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let serverTabs = await fetchTabs();

        // Empty state: create one default Work tab
        if (serverTabs.length === 0) {
          const newTab = await serverCreateTab('work');
          serverTabs = [newTab];
        }

        if (cancelled) return;

        const loadedTabs: Tab[] = serverTabs.map((t) => ({
          id: t.id,
          type: t.type as TabType,
          title: t.title,
        }));

        // Pre-populate createdSessions for restored terminal/code tabs
        const ptyTabIds = loadedTabs
          .filter((t) => t.type === 'terminal' || t.type === 'code')
          .map((t) => t.id);
        preloadSessions(ptyTabIds);

        setTabs(loadedTabs);

        // Restore per-device active tab, or default to first
        const savedActive = localStorage.getItem(ACTIVE_TAB_KEY);
        const validActive = savedActive && loadedTabs.some((t) => t.id === savedActive);
        setActiveTabId(validActive ? savedActive : loadedTabs[0].id);
      } catch {
        // Fallback: create a default tab
        try {
          const newTab = await serverCreateTab('work');
          if (!cancelled) {
            setTabs([{ id: newTab.id, type: newTab.type as TabType, title: newTab.title }]);
            setActiveTabId(newTab.id);
          }
        } catch {
          // Fatal — can't reach server
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist active tab per-device
  useEffect(() => {
    if (activeTabId) {
      localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
    }
  }, [activeTabId]);

  // Reconcile server state on startup — clean up orphaned PTY/agent/DB resources
  useEffect(() => {
    if (loading) return;
    const tabIds = tabsRef.current.map((t) => t.id);
    authFetch('/api/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabIds }),
    }).catch(() => {});
  }, [loading]);

  // Load conversation settings for work tabs on startup
  useEffect(() => {
    if (loading) return;
    const workTabs = tabsRef.current.filter((t) => t.type === 'work');
    for (const tab of workTabs) {
      authFetch(`/api/conversations/${tab.id}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((conv) => {
          if (!conv) return;
          updateTabSettings(tab.id, {
            ...(conv.model ? { model: conv.model } : {}),
            ...(conv.thinking_enabled != null ? { thinkingEnabled: !!conv.thinking_enabled } : {}),
            ...(conv.thinking_budget ? { thinkingBudget: conv.thinking_budget } : {}),
            ...(conv.thinking_effort ? { thinkingEffort: conv.thinking_effort } : {}),
          });
        })
        .catch(() => {});
    }
  }, [loading, updateTabSettings]);

  const addTab = useCallback(async (type: TabType) => {
    try {
      const tab = await serverCreateTab(type);
      const newTab: Tab = { id: tab.id, type: tab.type as TabType, title: tab.title };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch {
      // Server error — don't add tab
    }
  }, []);

  const closeTab = useCallback((id: string) => {
    const closing = tabsRef.current.find((t) => t.id === id);

    if (closing?.type === 'work') {
      // Abort active stream and clear streaming store
      const stream = getStream(id);
      if (stream?.streaming) {
        stream.abortController.abort();
      }
      clearStream(id);
    }

    // Server handles PTY kill, agent session clear, conversation delete, and tab delete
    serverDeleteTab(id).catch(() => {});

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // Switch active tab if we're closing the active one
      setActiveTabId((active) => {
        if (active === id) {
          if (next.length === 0) return '';
          const idx = prev.findIndex((t) => t.id === id);
          return next[Math.min(idx, next.length - 1)].id;
        }
        return active;
      });
      return next;
    });
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));

    // Update on server (handles both tab title and conversation title for work tabs)
    serverRenameTab(id, title).catch(() => {});

    // Also update conversation title for Work tabs
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.type === 'work') {
      authFetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }).catch(() => {});
    }
  }, []);

  const reorderTabs = useCallback((orderedIds: string[]) => {
    setTabs((prev) => {
      const map = new Map(prev.map((t) => [t.id, t]));
      return orderedIds.map((id) => map.get(id)!).filter(Boolean);
    });

    serverReorderTabs(orderedIds).catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className='flex items-center justify-center h-screen bg-iris-bg text-iris-text-muted'>
        Loading...
      </div>
    );
  }

  return (
    <div className='app-container flex flex-col'>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        streamingTabIds={streamingTabIds}
        authEnabled={authEnabled}
        tabSettings={tabSettings}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onAddTab={addTab}
        onRenameTab={renameTab}
        onReorderTabs={reorderTabs}
        onUpdateTabSettings={updateTabSettings}
        onLogout={onLogout}
      />
      <div className='flex-1 relative min-h-0'>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className='absolute inset-0'
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            {tab.type === 'terminal' && (
              <TerminalTab tabId={tab.id} visible={tab.id === activeTabId} />
            )}
            {tab.type === 'code' && (
              <TerminalTab tabId={tab.id} visible={tab.id === activeTabId} command='claude' />
            )}
            {tab.type === 'work' && (
              <WorkTab
                tabId={tab.id}
                visible={tab.id === activeTabId}
                settings={getTabSettings(tab.id)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
