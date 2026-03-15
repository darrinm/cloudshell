import type { TabType } from '../components/TabBar';
import { authFetch } from './authFetch';

export interface ServerTab {
  id: string;
  type: TabType;
  title: string;
  sort_order: number;
}

export async function fetchTabs(): Promise<ServerTab[]> {
  const res = await authFetch('/api/tabs');
  if (!res.ok) throw new Error('Failed to fetch tabs');
  const data = await res.json();
  return data.tabs;
}

export async function serverCreateTab(type: TabType, title?: string): Promise<ServerTab> {
  const res = await authFetch('/api/tabs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, title }),
  });
  if (!res.ok) throw new Error('Failed to create tab');
  return res.json();
}

export async function serverDeleteTab(id: string): Promise<void> {
  await authFetch(`/api/tabs/${id}`, { method: 'DELETE' });
}

export async function serverRenameTab(id: string, title: string): Promise<void> {
  await authFetch(`/api/tabs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export async function serverReorderTabs(orderedIds: string[]): Promise<void> {
  await authFetch('/api/tabs/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
}
