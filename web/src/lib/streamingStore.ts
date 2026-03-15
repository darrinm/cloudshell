import { useSyncExternalStore } from 'react';

import {
  AgentEvent,
  ClientBlockAccumulator,
  ContentBlock,
} from '../components/ContentBlocksDisplay';
import { authFetch } from './authFetch';

export interface ContextUsage {
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  systemTokens: number;
  memoryTokens?: number;
  toolCategories: Record<string, number>;
  promptTokens: number;
  agentTokens: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  timestamp: Date;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
}

export interface TabStream {
  streaming: boolean;
  blocks: ContentBlock[];
  abortController: AbortController;
  tabId: string;
  contextUsage: ContextUsage | null;
  error: string | null;
  completedMessage: ChatMessage | null;
  compactedMessages: ChatMessage[] | null;
  slashCommands: SlashCommandInfo[] | null;
}

interface InternalStream {
  acc: ClientBlockAccumulator;
  snapshot: TabStream;
  serverMessageId: string | null;
}

const streams = new Map<string, InternalStream>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();

function notifyListeners(tabId: string) {
  listeners.get(tabId)?.forEach((fn) => fn());
  globalListeners.forEach((fn) => fn());
}

function replaceSnapshot(tabId: string, updates: Partial<TabStream>) {
  const internal = streams.get(tabId);
  if (!internal) return;
  internal.snapshot = { ...internal.snapshot, ...updates };
  notifyListeners(tabId);
}

export function getStream(tabId: string): TabStream | undefined {
  return streams.get(tabId)?.snapshot;
}

export function subscribe(tabId: string, listener: () => void): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(tabId);
  };
}

export function startStream(tabId: string, abortController: AbortController): void {
  const timer = cleanupTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(tabId);
  }
  const snapshot: TabStream = {
    streaming: true,
    blocks: [],
    abortController,
    tabId,
    contextUsage: null,
    error: null,
    completedMessage: null,
    compactedMessages: null,
    slashCommands: null,
  };
  streams.set(tabId, { acc: new ClientBlockAccumulator(), snapshot, serverMessageId: null });
  notifyListeners(tabId);
}

export function updateBlocks(tabId: string, blocks: ContentBlock[]) {
  replaceSnapshot(tabId, { blocks });
}

export function updateContextUsage(tabId: string, usage: ContextUsage) {
  replaceSnapshot(tabId, { contextUsage: usage });
}

export function updateCompactedMessages(tabId: string, messages: ChatMessage[]) {
  replaceSnapshot(tabId, { compactedMessages: messages });
}

// Global slash commands cache — shared across all tabs, persisted to sessionStorage
let globalSlashCommands: SlashCommandInfo[] | null = (() => {
  try {
    const stored = sessionStorage.getItem('cloudshell:slashCommands');
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    // Normalize: old cache may contain plain strings
    return parsed.map((c: any) => (typeof c === 'string' ? { name: c, description: '' } : c));
  } catch {
    return null;
  }
})();

export function getSlashCommands(): SlashCommandInfo[] | null {
  return globalSlashCommands;
}

const slashCommandListeners = new Set<() => void>();

export function subscribeSlashCommands(listener: () => void): () => void {
  slashCommandListeners.add(listener);
  return () => {
    slashCommandListeners.delete(listener);
  };
}

export function updateSlashCommands(tabId: string, commands: SlashCommandInfo[]) {
  replaceSnapshot(tabId, { slashCommands: commands });
  globalSlashCommands = commands;
  try {
    sessionStorage.setItem('cloudshell:slashCommands', JSON.stringify(commands));
  } catch {}
  slashCommandListeners.forEach((fn) => fn());
}

function scheduleCleanup(tabId: string) {
  const existing = cleanupTimers.get(tabId);
  if (existing) clearTimeout(existing);
  cleanupTimers.set(
    tabId,
    setTimeout(() => {
      streams.delete(tabId);
      cleanupTimers.delete(tabId);
      notifyListeners(tabId);
    }, 60_000),
  );
}

export function completeStream(tabId: string, message: ChatMessage) {
  replaceSnapshot(tabId, { streaming: false, completedMessage: message });
  scheduleCleanup(tabId);
}

export function failStream(tabId: string, error: string, partialMessage?: ChatMessage) {
  const updates: Partial<TabStream> = { streaming: false, error };
  if (partialMessage) updates.completedMessage = partialMessage;
  replaceSnapshot(tabId, updates);
  scheduleCleanup(tabId);
}

export function clearStream(tabId: string) {
  const timer = cleanupTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(tabId);
  }
  streams.delete(tabId);
  notifyListeners(tabId);
}

function getAcc(tabId: string): ClientBlockAccumulator | undefined {
  return streams.get(tabId)?.acc;
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
  effort?: string;
}

export async function runStream(
  tabId: string,
  apiMessages: Array<{ role: string; content: any }>,
  model: string,
  signal: AbortSignal,
  thinking?: ThinkingConfig,
): Promise<void> {
  const acc = getAcc(tabId);
  if (!acc) return;

  try {
    const body: Record<string, unknown> = { messages: apiMessages, model, tab_id: tabId };
    if (thinking?.enabled) {
      body.thinking = { budget_tokens: thinking.budgetTokens, effort: thinking.effort };
    }
    const response = await authFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sseError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event: AgentEvent = JSON.parse(data);

            if (event.type === 'context') {
              if (event.usage) updateContextUsage(tabId, event.usage as ContextUsage);
            } else if (event.type === 'compacted') {
              if (event.messages) {
                const summaryMsg = (event.messages as any[]).find((m: any) => m.role === 'user');
                const summaryText =
                  summaryMsg?.content?.replace(/^\[Conversation summary\]\s*\n*/, '') ||
                  'Earlier conversation was summarized.';
                const compactedChatMessages: ChatMessage[] = [
                  {
                    id: `compaction-summary-${Date.now()}`,
                    role: 'assistant',
                    blocks: [
                      { type: 'compaction_divider' as const },
                      { type: 'text' as const, content: summaryText },
                    ],
                    timestamp: new Date(),
                  },
                ];
                updateCompactedMessages(tabId, compactedChatMessages);
              }
            } else if (event.type === 'slash_commands') {
              if (event.commands) {
                // Normalize: server may send string[] or {name, description}[]
                const cmds: SlashCommandInfo[] = event.commands.map((c: any) =>
                  typeof c === 'string' ? { name: c, description: '' } : c,
                );
                updateSlashCommands(tabId, cmds);
              }
            } else if (event.type === 'saved') {
              // Server saved the assistant message — capture its ID
              const internal = streams.get(tabId);
              if (internal && event.messageId) {
                internal.serverMessageId = event.messageId;
              }
            } else if (event.type === 'error') {
              sseError = event.message || 'Server error';
              acc.process(event);
              updateBlocks(tabId, acc.snapshot());
            } else {
              acc.process(event);
              updateBlocks(tabId, acc.snapshot());
            }
          } catch (e) {
            console.error('Failed to parse SSE event:', e);
          }
        }
      }
    }

    const internal = streams.get(tabId);
    const assistantMessage: ChatMessage = {
      id: internal?.serverMessageId || `assistant-${Date.now()}`,
      role: 'assistant',
      blocks: acc.blocks.length > 0 ? acc.blocks : [{ type: 'text', content: '' }],
      timestamp: new Date(),
    };

    if (sseError) {
      failStream(tabId, sseError, assistantMessage);
    } else {
      completeStream(tabId, assistantMessage);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (acc.blocks.length > 0) {
        const finalBlocks = acc.blocks.map((block: ContentBlock) => {
          if (block.type === 'tool_use' && !('result' in block)) {
            return { ...block, result: { cancelled: true, message: 'Request stopped by user' } };
          }
          return block;
        });
        finalBlocks.push({ type: 'text', content: '*(stopped)*' });
        const partialMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          blocks: finalBlocks,
          timestamp: new Date(),
        };
        failStream(tabId, 'aborted', partialMessage);
      } else {
        failStream(tabId, 'aborted');
      }
    } else {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        blocks: [{ type: 'text', content: `Failed to get response: ${errorMsg}` }],
        timestamp: new Date(),
      };
      failStream(tabId, errorMsg, errorMessage);
    }
  }
}

// React hooks
export function useStream(tabId: string | undefined): TabStream | undefined {
  return useSyncExternalStore(
    (cb) => {
      if (!tabId) return () => {};
      return subscribe(tabId, cb);
    },
    () => (tabId ? getStream(tabId) : undefined),
  );
}

// Streaming tab IDs — referentially stable snapshot
let streamingTabIdsSnapshot: string[] = [];

function getStreamingTabIds(): string[] {
  const ids: string[] = [];
  for (const [tabId, internal] of streams) {
    if (internal.snapshot.streaming) ids.push(tabId);
  }
  // Only create a new array reference if contents changed
  if (
    ids.length !== streamingTabIdsSnapshot.length ||
    ids.some((id, i) => id !== streamingTabIdsSnapshot[i])
  ) {
    streamingTabIdsSnapshot = ids;
  }
  return streamingTabIdsSnapshot;
}

function subscribeGlobal(listener: () => void): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function useStreamingTabIds(): string[] {
  return useSyncExternalStore(subscribeGlobal, getStreamingTabIds);
}

export function useSlashCommands(): SlashCommandInfo[] | null {
  return useSyncExternalStore(subscribeSlashCommands, getSlashCommands);
}
