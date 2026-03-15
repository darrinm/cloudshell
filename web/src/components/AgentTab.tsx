import 'github-markdown-css/github-markdown-dark.css';
import { type KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import type { TabSettings } from '../App';
import { IS_TOUCH, useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { authFetch } from '../lib/authFetch';
import {
  type ChatMessage,
  type SlashCommandInfo,
  getStream,
  runStream,
  clearStream as storeClearStream,
  startStream as storeStartStream,
  useSlashCommands,
  useStream,
} from '../lib/streamingStore';
import { type ContentBlock, MarkdownBlock, type SubTaskBlock } from './ContentBlocksDisplay';
import ContextMeter, { type ContextUsage } from './ContextMeter';

const SERVER_SIDE_TOOLS = ['web_search', 'web_fetch', 'tool_search'];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateFilename(name: string, maxLen = 24): string {
  if (name.length <= maxLen) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const keep = maxLen - ext.length - 1;
  if (keep < 4) return name.slice(0, maxLen - 1) + '...';
  const headLen = Math.ceil(keep / 2);
  const tailLen = Math.floor(keep / 2);
  return stem.slice(0, headLen) + '...' + stem.slice(-tailLen) + ext;
}

function convertToApiMessages(messages: ChatMessage[]): Array<{ role: string; content: any }> {
  const apiMessages: Array<{ role: string; content: any }> = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const imageBlocks = msg.blocks.filter(
        (b): b is ContentBlock & { type: 'image' } => b.type === 'image',
      );
      const fileBlocks = msg.blocks.filter(
        (b): b is ContentBlock & { type: 'file' } => b.type === 'file',
      );
      const textContent = msg.blocks
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.resolvedContent || b.content)
        .filter(Boolean)
        .join('\n');

      if (imageBlocks.length > 0 || fileBlocks.length > 0) {
        const content: any[] = [];
        for (const img of imageBlocks) {
          content.push({ type: 'image', source: { type: 'url', url: img.url } });
        }
        if (textContent) content.push({ type: 'text', text: textContent });
        apiMessages.push({ role: 'user', content });
      } else if (textContent) {
        apiMessages.push({ role: 'user', content: textContent });
      }
    } else {
      let currentAssistantContent: any[] = [];
      for (const block of msg.blocks) {
        if (block.type === 'text') {
          if (block.content) currentAssistantContent.push({ type: 'text', text: block.content });
        } else if (block.type === 'tool_use') {
          if (SERVER_SIDE_TOOLS.includes(block.name) || block.name.includes('/')) continue;
          currentAssistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          if (currentAssistantContent.length > 0) {
            apiMessages.push({ role: 'assistant', content: currentAssistantContent });
            currentAssistantContent = [];
          }
          if (block.result !== undefined) {
            apiMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content:
                    typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
                },
              ],
            });
          } else {
            apiMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  is_error: true,
                  content: 'Error: tool call was interrupted.',
                },
              ],
            });
          }
        }
      }
      if (currentAssistantContent.length > 0) {
        apiMessages.push({ role: 'assistant', content: currentAssistantContent });
      }
    }
  }
  return apiMessages;
}

interface AgentTabProps {
  tabId: string;
  visible?: boolean;
  settings: TabSettings;
}

export default function AgentTab({ tabId, settings }: AgentTabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const streamState = useStream(tabId);
  const streaming = streamState?.streaming ?? false;
  const streamingBlocks = streamState?.blocks ?? [];
  const slashCommands = useSlashCommands();
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const keyboardHeight = useKeyboardHeight();
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom({
    initial: 'smooth',
    resize: 'smooth',
  });
  const [pendingFiles, setPendingFiles] = useState<
    { path: string; filename: string; size: number; mimeType: string; previewUrl?: string }[]
  >([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<{ path: string; type: string }[]>([]);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Load chat history from server on mount
  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const res = await authFetch(`/api/conversations/${tabId}/messages`);
        if (!res.ok || cancelled) return;
        const rows = await res.json();
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        const loaded: ChatMessage[] = rows.map(
          (row: { id: string; role: string; blocks: string; timestamp: string }) => ({
            id: row.id,
            role: row.role as 'user' | 'assistant',
            blocks: JSON.parse(row.blocks),
            timestamp: new Date(row.timestamp),
          }),
        );
        setMessages(loaded);
      } catch {
        // Server may not have this conversation yet — that's fine
      }
    }
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  // Slash command autocomplete
  // SDK sends command names without leading slash (e.g. "help", "clear")
  const slashPrefix = input.startsWith('/') ? input.slice(1).toLowerCase() : null;
  const filteredCommands: SlashCommandInfo[] =
    slashPrefix !== null && slashCommands && slashCommands.length > 0
      ? slashCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(slashPrefix)).slice(0, 8)
      : [];
  const showSlashMenu = filteredCommands.length > 0;
  const [selectedCommandIdx, setSelectedCommandIdx] = useState(0);

  // @-mention autocomplete: detect mention query from cursor position
  const detectMention = useCallback((value: string, cursorPos: number) => {
    // Scan backwards from cursor to find @
    let i = cursorPos - 1;
    while (i >= 0 && value[i] !== '@' && value[i] !== ' ' && value[i] !== '\n') i--;
    if (i >= 0 && value[i] === '@' && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\n')) {
      const query = value.slice(i + 1, cursorPos);
      setMentionQuery(query);
      setSelectedMentionIdx(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  // Fetch mention suggestions
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionResults([]);
      return;
    }
    if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    mentionDebounceRef.current = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/project/files?q=${encodeURIComponent(mentionQuery)}`);
        if (res.ok) {
          const results = await res.json();
          setMentionResults(results);
        }
      } catch {
        /* ignore */
      }
    }, 150);
    return () => {
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    };
  }, [mentionQuery]);

  const showMentionMenu = mentionQuery !== null && mentionResults.length > 0;

  const selectMention = useCallback(
    (filePath: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const value = input;
      const cursorPos = ta.selectionStart;
      // Find the @ position
      let i = cursorPos - 1;
      while (i >= 0 && value[i] !== '@') i--;
      if (i < 0) return;
      const before = value.slice(0, i);
      const after = value.slice(cursorPos);
      const newValue = `${before}@${filePath} ${after}`;
      setInput(newValue);
      setMentionQuery(null);
      setMentionResults([]);
      // Set cursor after the inserted mention
      requestAnimationFrame(() => {
        const pos = before.length + 1 + filePath.length + 1;
        ta.selectionStart = ta.selectionEnd = pos;
        ta.focus();
      });
    },
    [input],
  );

  // Pick up completed stream
  useEffect(() => {
    if (streamState?.completedMessage && !streamState.streaming) {
      const msg = streamState.completedMessage;
      setMessages((prev) => [...prev, msg]);
      if (streamState.contextUsage) setContextUsage(streamState.contextUsage);
      storeClearStream(tabId);
      // Assistant message is saved server-side during streaming — no client save needed
    }
    if (streamState?.compactedMessages) {
      setMessages((prev) => [...streamState.compactedMessages!, ...prev]);
    }
  }, [
    streamState?.completedMessage,
    streamState?.streaming,
    streamState?.compactedMessages,
    tabId,
  ]);

  // Update context usage from stream
  useEffect(() => {
    if (streamState?.contextUsage) setContextUsage(streamState.contextUsage);
  }, [streamState?.contextUsage]);

  const uploadFile = async (
    file: File,
  ): Promise<{
    path: string;
    filename: string;
    size: number;
    mimeType: string;
    url: string;
  } | null> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await authFetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        path: data.url,
        filename: data.originalName,
        size: file.size,
        mimeType: file.type,
        url: data.url,
      };
    } catch {
      return null;
    }
  };

  const handleFileSelect = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (result) {
        // Use blob URL for image thumbnails so preview works immediately
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPendingFiles((prev) => [
          ...prev,
          {
            path: result.url,
            filename: result.filename,
            size: result.size,
            mimeType: result.mimeType,
            previewUrl,
          },
        ]);
      }
    }
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;
    if (streaming) return;

    const userBlocks: ContentBlock[] = [];
    for (const f of pendingFiles) {
      if (f.mimeType.startsWith('image/')) {
        userBlocks.push({ type: 'image', imageId: f.path, url: f.path });
      } else {
        userBlocks.push({
          type: 'file',
          fileId: f.path,
          filename: f.filename,
          size: f.size,
          mimeType: f.mimeType,
          url: f.path,
        });
      }
    }
    if (text) {
      // Resolve @-mentions: extract file paths and fetch contents
      const mentionRegex = /@([\w.\/\-]+)/g;
      const mentions = [...text.matchAll(mentionRegex)].map((m) => m[1]);
      let resolvedContent: string | undefined;
      if (mentions.length > 0) {
        const fileContents: string[] = [];
        await Promise.all(
          mentions.map(async (filePath) => {
            try {
              const res = await authFetch(`/api/project/file?path=${encodeURIComponent(filePath)}`);
              if (res.ok) {
                const data = await res.json();
                if (data.type === 'file' && data.content) {
                  fileContents.push(`<file path="${data.path}">\n${data.content}\n</file>`);
                } else if (data.type === 'dir' && data.entries) {
                  fileContents.push(
                    `<file path="${data.path}" type="directory">\n${data.entries.join('\n')}\n</file>`,
                  );
                }
              }
            } catch {
              /* skip unresolvable mentions */
            }
          }),
        );
        if (fileContents.length > 0) {
          resolvedContent = fileContents.join('\n\n') + '\n\n' + text;
        }
      }
      userBlocks.push({
        type: 'text',
        content: text,
        ...(resolvedContent ? { resolvedContent } : {}),
      });
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      blocks: userBlocks,
      timestamp: new Date(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setPendingFiles((prev) => {
      for (const f of prev) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      }
      return [];
    });
    if (IS_TOUCH) textareaRef.current?.blur();

    // Persist user message to server
    authFetch(`/api/conversations/${tabId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: userMessage.id,
        role: 'user',
        blocks: userMessage.blocks,
        timestamp: userMessage.timestamp.toISOString(),
      }),
    }).catch(() => {});

    const abortController = new AbortController();
    storeStartStream(tabId, abortController);

    const apiMessages = convertToApiMessages(newMessages);
    await runStream(
      tabId,
      apiMessages,
      settings.model,
      abortController.signal,
      settings.thinkingEnabled
        ? {
            enabled: true,
            budgetTokens: settings.thinkingBudget,
            effort: settings.thinkingEffort,
          }
        : undefined,
    );
  }, [input, pendingFiles, streaming, messages, tabId, settings]);

  const stopStreaming = useCallback(() => {
    const stream = getStream(tabId);
    if (stream?.streaming) {
      stream.abortController.abort();
    }
  }, [tabId]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIdx((prev) => Math.min(prev + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (mentionResults[selectedMentionIdx]) {
          e.preventDefault();
          selectMention(mentionResults[selectedMentionIdx].path);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIdx((prev) => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (filteredCommands[selectedCommandIdx]) {
          e.preventDefault();
          setInput(`/${filteredCommands[selectedCommandIdx].name} `);
          setSelectedCommandIdx(0);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedCommandIdx(0);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      const h = Math.min(ta.scrollHeight, 200);
      ta.style.height = h + 'px';
      ta.style.overflowY = ta.scrollHeight > 200 ? 'auto' : 'hidden';
    }
  }, [input]);

  // Re-stick to bottom when keyboard opens/closes or messages change
  useEffect(() => {
    scrollToBottom();
  }, [keyboardHeight, messages.length, scrollToBottom]);

  // Drag-drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files);
  };

  // Paste handler
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          const previewUrl = URL.createObjectURL(file);
          uploadFile(file).then((result) => {
            if (result) {
              setPendingFiles((prev) => [
                ...prev,
                {
                  path: result.url,
                  filename: result.filename,
                  size: result.size,
                  mimeType: result.mimeType,
                  previewUrl,
                },
              ]);
            } else {
              URL.revokeObjectURL(previewUrl);
            }
          });
        }
        return;
      }
    }
  };

  return (
    <div
      className='flex flex-col h-full bg-iris-bg'
      style={keyboardHeight > 0 ? { height: `calc(100% - ${keyboardHeight}px)` } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className='absolute inset-0 z-20 bg-iris-primary/10 border-2 border-dashed border-iris-primary rounded-lg flex items-center justify-center'>
          <p className='text-iris-primary text-lg font-medium'>Drop files here</p>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className='flex-1 overflow-auto min-h-0'>
        <div ref={contentRef} className='px-4 py-4 space-y-4'>
          {messages.length === 0 && !streaming && (
            <div className='flex items-center justify-center h-full min-h-[200px]'>
              <div className='text-center space-y-3'>
                <p className='text-iris-text-muted text-lg'>Start a conversation</p>
                <div className='flex flex-wrap gap-2 justify-center'>
                  {['Explain this codebase', 'Find bugs in the code', 'Write a test'].map(
                    (prompt) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setInput(prompt);
                          textareaRef.current?.focus();
                        }}
                        className='px-3 py-1.5 text-sm text-iris-text-secondary bg-iris-surface rounded-lg hover:bg-iris-surface-hover transition-colors border border-iris-border'
                      >
                        {prompt}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {/* Streaming blocks */}
          {streaming && streamingBlocks.length > 0 && (
            <div className='space-y-2'>
              <BlocksRenderer blocks={streamingBlocks} />
            </div>
          )}

          {/* Streaming indicator */}
          {streaming && streamingBlocks.length === 0 && (
            <div className='flex items-center gap-2 text-iris-text-muted'>
              <div className='flex gap-1'>
                <span
                  className='w-1.5 h-1.5 bg-iris-text-muted rounded-full animate-bounce'
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className='w-1.5 h-1.5 bg-iris-text-muted rounded-full animate-bounce'
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className='w-1.5 h-1.5 bg-iris-text-muted rounded-full animate-bounce'
                  style={{ animationDelay: '300ms' }}
                />
              </div>
              <span className='text-sm sr-only'>Thinking...</span>
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div
        className='border-t border-iris-border pl-2 pr-4 pt-2 pb-2 bg-iris-bg'
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        {/* Pending files */}
        {pendingFiles.length > 0 && (
          <div className='flex flex-wrap gap-2 mb-2'>
            {pendingFiles.map((f, i) => (
              <div
                key={i}
                className='flex items-center gap-1.5 px-2 py-1 bg-iris-surface rounded-lg text-xs text-iris-text-secondary border border-iris-border'
              >
                {f.mimeType.startsWith('image/') ? (
                  <img
                    src={f.previewUrl || f.path}
                    alt=''
                    className='w-8 h-8 rounded object-cover'
                  />
                ) : (
                  <span>{truncateFilename(f.filename)}</span>
                )}
                <span className='text-iris-text-faint'>{formatFileSize(f.size)}</span>
                <button
                  onClick={() =>
                    setPendingFiles((prev) => {
                      if (prev[i]?.previewUrl) URL.revokeObjectURL(prev[i].previewUrl!);
                      return prev.filter((_, idx) => idx !== i);
                    })
                  }
                  className='p-0.5 rounded hover:bg-iris-surface-active text-iris-text-faint hover:text-iris-text'
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
          </div>
        )}

        {/* Slash command menu */}
        {showSlashMenu && (
          <div className='mb-2 bg-iris-surface rounded-lg border border-iris-border shadow-float py-1'>
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                className={`w-full px-3 py-1 text-left text-[13px] flex items-baseline min-w-0 ${
                  i === selectedCommandIdx
                    ? 'bg-iris-surface-hover text-iris-text'
                    : 'text-iris-text-secondary'
                }`}
                onClick={() => {
                  setInput(`/${cmd.name} `);
                  setSelectedCommandIdx(0);
                  textareaRef.current?.focus();
                }}
                onMouseEnter={() => setSelectedCommandIdx(i)}
              >
                <span className='font-mono shrink-0 w-44'>/{cmd.name}</span>
                {cmd.description && (
                  <span className='text-iris-text-tertiary truncate'>{cmd.description}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* @-mention autocomplete menu */}
        {showMentionMenu && (
          <div className='mb-2 bg-iris-surface rounded-lg border border-iris-border shadow-float py-1 max-h-48 overflow-auto'>
            {mentionResults.map((file, i) => (
              <button
                key={file.path}
                className={`w-full px-3 py-1 text-left text-[13px] font-mono flex items-center gap-2 ${
                  i === selectedMentionIdx
                    ? 'bg-iris-surface-hover text-iris-text'
                    : 'text-iris-text-secondary'
                }`}
                onClick={() => selectMention(file.path)}
                onMouseEnter={() => setSelectedMentionIdx(i)}
              >
                <svg
                  className='w-3.5 h-3.5 shrink-0 text-iris-text-muted'
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={1.5}
                    d='M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z'
                  />
                </svg>
                <span className='truncate'>{file.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className='flex items-start gap-2'>
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className='w-9 h-9 flex items-center justify-center rounded-lg text-iris-text-secondary hover:text-iris-text hover:bg-iris-surface transition-colors shrink-0'
            title='Attach file'
            aria-label='Attach file'
          >
            <svg className='w-5 h-5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M12 4v16m8-8H4'
              />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type='file'
            multiple
            className='hidden'
            onChange={(e) => {
              if (e.target.files) handleFileSelect(e.target.files);
              e.target.value = '';
            }}
          />

          {/* Textarea */}
          <div className='flex-1 relative'>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSelectedCommandIdx(0);
                detectMention(e.target.value, e.target.selectionStart);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder='Send a message...'
              rows={1}
              className='w-full resize-none bg-iris-surface text-iris-text placeholder:text-iris-text-faint rounded-lg px-3 py-[7px] min-h-9 text-base md:text-sm leading-snug border border-iris-border focus:outline-none focus:border-iris-primary transition-colors overflow-hidden'
              style={{ maxHeight: 200 }}
            />
          </div>

          {/* Send/Stop button */}
          {streaming ? (
            <button
              onClick={stopStreaming}
              className='w-9 h-9 flex items-center justify-center rounded-lg bg-iris-error/20 text-iris-error hover:bg-iris-error/30 transition-colors shrink-0'
              title='Stop'
              aria-label='Stop'
            >
              <svg className='w-5 h-5' fill='currentColor' viewBox='0 0 24 24'>
                <rect x='6' y='6' width='12' height='12' rx='2' />
              </svg>
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim() && pendingFiles.length === 0}
              className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors shrink-0 ${
                input.trim() || pendingFiles.length > 0
                  ? 'bg-iris-primary text-iris-primary-text hover:opacity-90'
                  : 'bg-iris-surface text-iris-text-faint cursor-not-allowed'
              }`}
              title='Send'
              aria-label='Send'
            >
              <svg className='w-5 h-5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={2}
                  d='M12 19V5m-7 7l7-7 7 7'
                />
              </svg>
            </button>
          )}
        </div>
        {contextUsage && (
          <div className='mt-1'>
            <ContextMeter usage={contextUsage} />
          </div>
        )}
      </div>
    </div>
  );
}

// Message rendering components

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function getToolDescription(
  name: string,
  input: Record<string, unknown>,
  result?: unknown,
): string {
  const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '...' : s);
  switch (name) {
    case 'Read':
      return `Read ${input.file_path || 'file'}`;
    case 'Write':
      return `Write ${input.file_path || 'file'}`;
    case 'Edit':
      return `Edit ${input.file_path || 'file'}`;
    case 'Bash':
      return `${input.description || input.command || 'Run command'}`;
    case 'Glob':
      return `Search for ${input.pattern || 'files'}`;
    case 'Grep':
      return `Search for "${input.pattern || '...'}"${input.path ? ` in ${input.path}` : ''}`;
    case 'web_search':
      return `Search "${input.query || '...'}"`;
    case 'web_fetch':
      return `Fetch ${input.url || 'URL'}`;
    case 'Agent': {
      const desc = input.description ? String(input.description) : '';
      return desc ? truncate(desc, 60) : 'Agent';
    }
    case 'tool_search': {
      const query = input.query ? String(input.query) : '';
      const r = result as Record<string, unknown> | undefined;
      const tools = r?.tools as string[] | undefined;
      if (tools?.length) return `Found tools ${tools.join(', ')}`;
      return query ? `Searching for tools: ${query}` : 'Searching for tools...';
    }
    case 'run_task': {
      const prompt = input.prompt ? truncate(String(input.prompt), 60) : '';
      return `Sub-task${prompt ? ': ' + prompt : ''}`;
    }
    default:
      return name.replace(/_/g, ' ');
  }
}

function getResultSummary(
  name: string,
  result: unknown,
  nestedTools?: Array<{ name: string; elapsed?: number }>,
): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === 'object' && result !== null && 'cancelled' in result) return 'cancelled';
  if (name === 'Bash' && typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    if (r.exitCode !== undefined && r.exitCode !== 0) return `exit ${r.exitCode}`;
  }
  if (name === 'Agent' && nestedTools && nestedTools.length > 0) {
    return `${nestedTools.length} tool call${nestedTools.length !== 1 ? 's' : ''}`;
  }
  return 'done';
}

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const textContent = message.blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.content)
    .join('\n');

  const handleCopy = () => {
    if (!textContent) return;
    navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isUser) {
    return (
      <div className='group relative bg-iris-surface-hover p-4 rounded-lg'>
        {message.blocks.map((block, i) => {
          if (block.type === 'text')
            return (
              <div key={i} className='text-sm text-iris-text whitespace-pre-wrap'>
                {block.content}
              </div>
            );
          if (block.type === 'image')
            return (
              <img key={i} src={block.url} alt='' className='max-w-full max-h-64 rounded-lg my-1' />
            );
          if (block.type === 'file')
            return (
              <div key={i} className='flex items-center gap-2 text-xs text-iris-text-secondary'>
                <svg
                  className='w-4 h-4 shrink-0'
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={1.5}
                    d='M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z'
                  />
                </svg>
                <span>{block.filename}</span>
              </div>
            );
          return null;
        })}
        <div className='absolute right-2 bottom-1 flex items-center gap-2 text-xs text-iris-text-muted opacity-0 group-hover:opacity-100 transition-opacity bg-iris-bg-subtle/90 rounded px-1.5 py-0.5 backdrop-blur-sm'>
          {textContent && (
            <button
              onClick={handleCopy}
              className='hover:text-iris-text transition-colors duration-150'
              title='Copy'
              aria-label='Copy'
            >
              {copied ? (
                <svg
                  className='w-3.5 h-3.5 text-iris-success'
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={1.5}
                    d='M5 13l4 4L19 7'
                  />
                </svg>
              ) : (
                <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={1.5}
                    d='M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z'
                  />
                </svg>
              )}
            </button>
          )}
          {message.timestamp.toLocaleTimeString()}
        </div>
      </div>
    );
  }

  return (
    <div className='group relative'>
      <BlocksRenderer blocks={message.blocks} />
      <div className='absolute right-2 bottom-1 flex items-center gap-2 text-xs text-iris-text-muted opacity-0 group-hover:opacity-100 transition-opacity bg-iris-bg-subtle/90 rounded px-1.5 py-0.5 backdrop-blur-sm'>
        {textContent && (
          <button
            onClick={handleCopy}
            className='hover:text-iris-text transition-colors duration-150'
            title='Copy'
          >
            {copied ? (
              <svg
                className='w-3.5 h-3.5 text-iris-success'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M5 13l4 4L19 7'
                />
              </svg>
            ) : (
              <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z'
                />
              </svg>
            )}
          </button>
        )}
        {message.timestamp.toLocaleTimeString()}
      </div>
    </div>
  );
});

const BlocksRenderer = memo(function BlocksRenderer({ blocks }: { blocks: ContentBlock[] }) {
  // Group consecutive tool_use/thinking/redacted_thinking blocks so they share tight spacing
  type ActionBlock = ContentBlock & { type: 'tool_use' | 'thinking' | 'redacted_thinking' };
  const groupedBlocks: (ContentBlock | ActionBlock[])[] = [];
  let currentGroup: ActionBlock[] = [];

  for (const block of blocks) {
    if (
      block.type === 'tool_use' ||
      block.type === 'thinking' ||
      block.type === 'redacted_thinking'
    ) {
      currentGroup.push(block as ActionBlock);
    } else {
      if (currentGroup.length > 0) {
        groupedBlocks.push([...currentGroup]);
        currentGroup = [];
      }
      groupedBlocks.push(block);
    }
  }
  if (currentGroup.length > 0) {
    groupedBlocks.push(currentGroup);
  }

  return (
    <div className='space-y-3'>
      {groupedBlocks.map((item, i) => {
        if (Array.isArray(item)) {
          return <ActionGroup key={i} blocks={item} />;
        }
        const block = item;
        if (block.type === 'text') {
          if (!block.content) return null;
          return <MarkdownBlock key={i} content={block.content} />;
        }
        if (block.type === 'thinking') {
          return <ThinkingBlockDisplay key={i} block={block} />;
        }
        if (block.type === 'redacted_thinking') {
          return (
            <div
              key={i}
              className='flex items-center gap-2 px-3 py-2 text-xs text-iris-text-faint italic border border-iris-border/30 rounded-lg bg-iris-bg'
            >
              <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M12 15v.01M12 12a2 2 0 10-2-2'
                />
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z'
                />
              </svg>
              Redacted thinking
            </div>
          );
        }
        if (block.type === 'compaction_divider') {
          return (
            <div key={i} className='flex items-center gap-3 my-4'>
              <div className='flex-1 h-px bg-iris-border' />
              <span className='text-xs text-iris-text-faint'>Context compacted</span>
              <div className='flex-1 h-px bg-iris-border' />
            </div>
          );
        }
        if (block.type === 'sub_task_group') {
          return <SubTaskGroupDisplay key={i} block={block} />;
        }
        return null;
      })}
    </div>
  );
});

// Thinking block — Iris-style bordered card
const ThinkingBlockDisplay = memo(function ThinkingBlockDisplay({
  block,
}: {
  block: ContentBlock & { type: 'thinking' };
}) {
  const [expanded, setExpanded] = useState(false);
  const isStreaming = block.signature === undefined;

  return (
    <div>
      <div className='flex items-center justify-between hover:bg-iris-surface-hover rounded px-2 py-0.5 -ml-2 transition-colors duration-150'>
        <button
          onClick={() => setExpanded(!expanded)}
          className='flex items-center gap-2 min-w-0 flex-1 text-left'
        >
          {isStreaming ? (
            <div className='w-3.5 h-3.5 border-2 border-iris-thinking border-t-transparent rounded-full animate-spin shrink-0' />
          ) : (
            <svg
              className='w-3.5 h-3.5 text-iris-thinking shrink-0'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'
              />
            </svg>
          )}
          <span className='text-sm text-iris-text-secondary truncate'>
            {isStreaming ? 'Thinking...' : 'Thoughts'}
          </span>
        </button>
        <div className='flex items-center gap-2 shrink-0'>
          {block.content.length > 0 && (
            <span className='text-xs text-iris-text-muted'>
              ~{Math.round(block.content.length / 4)} tokens
            </span>
          )}
          {!isStreaming && (
            <svg
              className={`w-3 h-3 text-iris-text-faint transition-transform ${expanded ? '' : '-rotate-90'}`}
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M19 9l-7 7-7-7'
              />
            </svg>
          )}
        </div>
      </div>
      {expanded && block.content && (
        <div className='mt-1 mb-1 ml-5 pr-2'>
          <pre className='text-xs text-iris-text-secondary overflow-x-auto whitespace-pre-wrap font-mono max-h-64 overflow-y-auto'>
            {block.content}
          </pre>
        </div>
      )}
    </div>
  );
});

// Action group — renders thinking + tool blocks together with consistent spacing
type ActionBlock = ContentBlock & { type: 'tool_use' | 'thinking' | 'redacted_thinking' };

const RedactedThinkingInline = memo(function RedactedThinkingInline() {
  return (
    <div className='flex items-center gap-2 px-2 py-0.5 -ml-2 text-xs text-iris-text-faint italic'>
      <svg className='w-3.5 h-3.5 shrink-0' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
        <path
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth={1.5}
          d='M12 15v.01M12 12a2 2 0 10-2-2'
        />
        <path
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth={1.5}
          d='M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z'
        />
      </svg>
      Redacted thinking
    </div>
  );
});

const ActionGroup = memo(function ActionGroup({ blocks }: { blocks: ActionBlock[] }) {
  const toolBlocks = blocks.filter(
    (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
  );
  const [expanded, setExpanded] = useState(toolBlocks.length < 3);
  const hiddenCount = toolBlocks.length - 2;

  useEffect(() => {
    if (toolBlocks.length >= 3) setExpanded(false);
  }, [toolBlocks.length]);

  // When few tool blocks or expanded, render all blocks in order
  if (toolBlocks.length < 3 || expanded) {
    return (
      <div>
        {toolBlocks.length >= 3 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className='flex items-center gap-2 text-sm text-iris-text-muted hover:text-iris-text-secondary transition-colors duration-150 mb-1'
          >
            <svg
              className={`w-3 h-3 transition-transform`}
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M19 9l-7 7-7-7'
              />
            </svg>
            Hide steps
          </button>
        )}
        {blocks.map((block, i) => {
          if (block.type === 'thinking')
            return (
              <ThinkingBlockDisplay key={i} block={block as ContentBlock & { type: 'thinking' }} />
            );
          if (block.type === 'redacted_thinking') return <RedactedThinkingInline key={i} />;
          return (
            <ToolUseDisplay
              key={(block as any).id || i}
              tool={block as ContentBlock & { type: 'tool_use' }}
            />
          );
        })}
      </div>
    );
  }

  // Collapsed: show non-tool blocks + collapse toggle + last 2 tools
  const lastTwoTools = toolBlocks.slice(-2);
  return (
    <div>
      {blocks
        .filter((b) => b.type !== 'tool_use')
        .map((block, i) => {
          if (block.type === 'thinking')
            return (
              <ThinkingBlockDisplay key={i} block={block as ContentBlock & { type: 'thinking' }} />
            );
          return <RedactedThinkingInline key={i} />;
        })}
      <button
        onClick={() => setExpanded(true)}
        className='flex items-center gap-2 text-sm text-iris-text-muted hover:text-iris-text-secondary transition-colors duration-150 mb-1'
      >
        <svg
          className='w-3 h-3 transition-transform -rotate-90'
          fill='none'
          stroke='currentColor'
          viewBox='0 0 24 24'
        >
          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={1.5} d='M19 9l-7 7-7-7' />
        </svg>
        {hiddenCount} more step{hiddenCount !== 1 ? 's' : ''}
      </button>
      {lastTwoTools.map((tool, i) => (
        <ToolUseDisplay key={tool.id || i} tool={tool} />
      ))}
    </div>
  );
});

// Individual tool use — Iris-style row with gear icon, description, result summary
const ToolUseDisplay = memo(function ToolUseDisplay({
  tool,
}: {
  tool: ContentBlock & { type: 'tool_use' };
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [nestedExpanded, setNestedExpanded] = useState(false);
  const description = getToolDescription(tool.name, tool.input, tool.result);
  const resultSummary =
    tool.result !== undefined
      ? getResultSummary(tool.name, tool.result, tool.nestedTools)
      : undefined;

  const isAgent = tool.name === 'Agent';
  const nestedTools = tool.nestedTools;
  const isAgentRunning = isAgent && tool.result === undefined;

  // While running: show last 5 nested tools; when done: collapse unless expanded
  const visibleNested =
    isAgentRunning && nestedTools && nestedTools.length > 0
      ? nestedTools.slice(-5)
      : nestedExpanded && nestedTools
        ? nestedTools
        : undefined;

  return (
    <div>
      <div className='flex items-center justify-between hover:bg-iris-surface-hover rounded px-2 py-0.5 -ml-2 transition-colors duration-150'>
        <button
          onClick={(e) => {
            if (isAgent) {
              setNestedExpanded(!nestedExpanded);
            } else {
              setShowRaw(e.shiftKey);
              setExpanded(!expanded);
            }
          }}
          className='flex items-center gap-2 min-w-0 flex-1 text-left'
        >
          {/* Gear icon or spinner */}
          {tool.result === undefined && !tool.progress ? (
            <div className='w-3.5 h-3.5 border-2 border-iris-primary border-t-transparent rounded-full animate-spin shrink-0' />
          ) : (
            <svg
              className='w-3.5 h-3.5 text-iris-text-muted shrink-0'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z'
              />
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
              />
            </svg>
          )}
          <span className='text-sm text-iris-text-secondary truncate'>{description}</span>
          {tool.result === undefined && !tool.progress && (
            <span className='text-xs text-iris-warning shrink-0'>
              {Object.keys(tool.input).length === 0 ? 'generating...' : 'running...'}
            </span>
          )}
          {tool.progress && (
            <span className='text-xs text-iris-primary shrink-0'>{tool.progress}</span>
          )}
        </button>
        <div className='flex items-center gap-2 shrink-0'>
          {resultSummary && (
            <span className='text-xs text-iris-text-muted'>
              {resultSummary}
              {tool.duration && Math.round(tool.duration / 1000) > 0
                ? ` (${formatDuration(tool.duration)})`
                : ''}
            </span>
          )}
          {tool.result !== undefined && (
            <svg
              className={`w-3 h-3 text-iris-text-faint transition-transform ${(isAgent ? nestedExpanded : expanded) ? '' : '-rotate-90'}`}
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={1.5}
                d='M19 9l-7 7-7-7'
              />
            </svg>
          )}
        </div>
      </div>
      {/* Nested tool list for Agent blocks */}
      {isAgent && visibleNested && visibleNested.length > 0 && (
        <div className='ml-5 mt-0.5 mb-1'>
          {visibleNested.map((t, i) => {
            const isLast = isAgentRunning && i === visibleNested.length - 1;
            return (
              <div
                key={i}
                className={`text-xs font-mono leading-5 break-all ${isLast ? 'text-iris-text-secondary' : 'text-iris-text-faint'}`}
              >
                {t.name}
              </div>
            );
          })}
        </div>
      )}
      {expanded && tool.result !== undefined && !isAgent && (
        <div className='mt-1 mb-1 ml-5 pr-2'>
          {showRaw ? (
            <pre className='text-xs text-iris-text-muted overflow-auto max-h-96 bg-iris-bg p-2 rounded border border-iris-border'>
              <span className='text-iris-text-secondary'>// Input</span>
              {'\n'}
              {JSON.stringify(tool.input, null, 2)}
              {'\n\n'}
              <span className='text-iris-text-secondary'>// Output</span>
              {'\n'}
              {JSON.stringify(tool.result, null, 2)}
            </pre>
          ) : (
            <pre className='text-xs text-iris-text-secondary overflow-x-auto whitespace-pre-wrap font-mono max-h-64 overflow-y-auto'>
              {typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

// Sub-task group — Iris-style bordered card with header + divided list
const SubTaskGroupDisplay = memo(function SubTaskGroupDisplay({ block }: { block: SubTaskBlock }) {
  const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '...' : s);

  return (
    <div className='border border-iris-border rounded-lg overflow-hidden bg-iris-bg'>
      <div className='flex items-center gap-2 px-3 py-2 bg-iris-surface/50 border-b border-iris-border'>
        <svg
          className='w-4 h-4 text-iris-primary'
          fill='none'
          stroke='currentColor'
          viewBox='0 0 24 24'
        >
          <path
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={1.5}
            d='M4 6h16M4 12h16M4 18h16'
          />
        </svg>
        <span className='text-sm text-iris-text-secondary'>
          Parallel sub-tasks ({block.tasks.filter((t) => t.status === 'complete').length}/
          {block.tasks.length} complete)
        </span>
      </div>
      <div className='divide-y divide-iris-border'>
        {block.tasks.map((task) => (
          <div key={task.taskId} className='flex items-center gap-3 px-3 py-2'>
            {task.status === 'running' && (
              <div className='w-4 h-4 border-2 border-iris-primary border-t-transparent rounded-full animate-spin shrink-0' />
            )}
            {task.status === 'complete' && (
              <svg
                className='w-4 h-4 text-iris-success shrink-0'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M5 13l4 4L19 7'
                />
              </svg>
            )}
            {task.status === 'error' && (
              <svg
                className='w-4 h-4 text-iris-error shrink-0'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={1.5}
                  d='M6 18L18 6M6 6l12 12'
                />
              </svg>
            )}
            <div className='flex-1 min-w-0'>
              <div className='text-sm text-iris-text truncate'>{truncate(task.prompt, 80)}</div>
              <div className='text-xs text-iris-text-muted'>
                {task.model === 'claude-sonnet-4-6'
                  ? 'Sonnet'
                  : task.model === 'claude-opus-4-6'
                    ? 'Opus'
                    : 'Haiku'}
                {task.status === 'running' &&
                  task.step > 0 &&
                  ` · Step ${task.step} · ${task.currentTool}`}
                {task.status === 'complete' && ` · ${task.toolCallCount} steps`}
                {task.status === 'error' && ` · Failed: ${task.error || 'Unknown error'}`}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
