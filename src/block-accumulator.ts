/**
 * Server-side block accumulator for SSE agent events.
 * Mirrors the client-side ClientBlockAccumulator logic so the server
 * can save assistant messages (including on client disconnect).
 */
import type { AgentEvent } from './types.js';

export interface SubTaskInfo {
  taskId: string;
  prompt: string;
  model: string;
  status: 'running' | 'complete' | 'error';
  step: number;
  currentTool: string;
  toolsUsed: string[];
  toolCallCount: number;
  summary?: string;
  error?: string;
}

export interface SubTaskBlock {
  type: 'sub_task_group';
  tasks: SubTaskInfo[];
}

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: unknown; progress?: string; duration?: number; nestedTools?: Array<{ name: string; elapsed?: number }>; subagentSummary?: string }
  | { type: 'compaction_divider' }
  | { type: 'thinking'; id: string; content: string; signature?: string }
  | { type: 'redacted_thinking'; id: string; data: string }
  | SubTaskBlock;

export class BlockAccumulator {
  blocks: ContentBlock[] = [];
  private currentTextContent = '';

  process(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.currentTextContent += event.content || '';
        {
          const lastBlock = this.blocks[this.blocks.length - 1];
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.content = this.currentTextContent;
          } else {
            this.blocks.push({ type: 'text', content: this.currentTextContent });
          }
        }
        break;
      case 'tool_pending':
        this.currentTextContent = '';
        this.blocks.push({
          type: 'tool_use',
          id: event.id || `pending-${Date.now()}`,
          name: event.name || '',
          input: {},
        });
        break;
      case 'tool_call': {
        this.currentTextContent = '';
        const idx = this.blocks.findIndex(b => b.type === 'tool_use' && b.id === event.id && !('result' in b));
        if (idx >= 0) {
          this.blocks[idx] = { ...this.blocks[idx], input: event.input || {} } as ContentBlock;
        } else {
          this.blocks.push({
            type: 'tool_use',
            id: event.id || `fallback-${Date.now()}`,
            name: event.name || '',
            input: event.input || {},
          });
        }
        break;
      }
      case 'tool_progress': {
        const progressText = (event as any).total
          ? `${event.message} (${(event as any).current}/${(event as any).total})`
          : event.message || '';
        if (!progressText) break;
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          if (this.blocks[i].type === 'tool_use' && !('result' in this.blocks[i])) {
            this.blocks[i] = { ...this.blocks[i], progress: progressText } as ContentBlock;
            break;
          }
        }
        break;
      }
      case 'tool_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'tool_use' && block.id === event.tool_use_id && !('result' in block)) {
            this.blocks[i] = { ...block, result: event.result, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock;
            break;
          }
        }
        break;
      case 'web_search':
        this.currentTextContent = '';
        this.blocks.push({
          type: 'tool_use',
          id: `web_search-${Date.now()}`,
          name: 'web_search',
          input: { query: event.query || '' },
        });
        break;
      case 'web_search_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'tool_use' && block.name === 'web_search' && !('result' in block)) {
            this.blocks[i] = { ...block, result: { results: event.results }, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock;
            break;
          }
        }
        break;
      case 'web_fetch':
        this.currentTextContent = '';
        this.blocks.push({
          type: 'tool_use',
          id: `web_fetch-${Date.now()}`,
          name: 'web_fetch',
          input: { url: event.url || '' },
        });
        break;
      case 'web_fetch_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'tool_use' && block.name === 'web_fetch' && !('result' in block)) {
            this.blocks[i] = { ...block, result: { url: event.url, title: event.title }, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock;
            break;
          }
        }
        break;
      case 'error':
        this.currentTextContent += `\n\nError: ${event.message}`;
        {
          const lastTextBlock = this.blocks[this.blocks.length - 1];
          if (lastTextBlock && lastTextBlock.type === 'text') {
            lastTextBlock.content = this.currentTextContent;
          } else {
            this.blocks.push({ type: 'text', content: this.currentTextContent });
          }
        }
        break;
      case 'thinking_start':
        this.currentTextContent = '';
        this.blocks.push({ type: 'thinking', id: event.id || `thinking-${Date.now()}`, content: '' });
        break;
      case 'thinking_delta':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'thinking' && block.id === event.id) {
            this.blocks[i] = { ...block, content: block.content + (event.content || '') } as ContentBlock;
            break;
          }
        }
        break;
      case 'thinking_complete':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'thinking' && block.id === event.id) {
            this.blocks[i] = { ...block, signature: event.signature } as ContentBlock;
            break;
          }
        }
        break;
      case 'sub_task_start': {
        this.currentTextContent = '';
        const existingGroup = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined;
        const task: SubTaskInfo = {
          taskId: event.taskId || '', prompt: event.prompt || '', model: event.model || '',
          status: 'running', step: 0, currentTool: '', toolsUsed: [], toolCallCount: 0,
        };
        if (existingGroup) {
          const idx = this.blocks.indexOf(existingGroup);
          this.blocks[idx] = { type: 'sub_task_group', tasks: [...existingGroup.tasks, task] };
        } else {
          this.blocks.push({ type: 'sub_task_group', tasks: [task] });
        }
        break;
      }
      case 'sub_task_progress': {
        const group = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined;
        if (group) {
          const idx = this.blocks.indexOf(group);
          const tasks = group.tasks.map(t =>
            t.taskId === event.taskId
              ? { ...t, step: event.step || t.step, currentTool: event.toolName || t.currentTool }
              : t
          );
          this.blocks[idx] = { type: 'sub_task_group', tasks };
        }
        break;
      }
      case 'agent_tool_progress': {
        const parentId = event.tool_use_id;
        if (!parentId) break;
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i];
          if (block.type === 'tool_use' && block.id === parentId) {
            const existing = (block as any).nestedTools || [];
            this.blocks[i] = {
              ...block,
              nestedTools: [...existing, { name: event.name || '', elapsed: event.elapsed_time_seconds }],
            } as ContentBlock;
            break;
          }
        }
        break;
      }
      case 'sub_task_complete': {
        // Handle Agent tool completion via task_notification (tool_use_id targets the Agent block)
        if (event.tool_use_id && !event.taskId) {
          for (let i = this.blocks.length - 1; i >= 0; i--) {
            const block = this.blocks[i];
            if (block.type === 'tool_use' && block.id === event.tool_use_id) {
              this.blocks[i] = { ...block, subagentSummary: event.summary } as ContentBlock;
              break;
            }
          }
          break;
        }
        const grp = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined;
        if (grp) {
          const idx = this.blocks.indexOf(grp);
          const tasks = grp.tasks.map(t =>
            t.taskId === event.taskId
              ? {
                  ...t,
                  status: (event.error ? 'error' : 'complete') as SubTaskInfo['status'],
                  summary: event.summary, toolsUsed: event.toolsUsed || t.toolsUsed,
                  toolCallCount: event.toolCallCount ?? t.toolCallCount, error: event.error,
                }
              : t
          );
          this.blocks[idx] = { type: 'sub_task_group', tasks };
        }
        break;
      }
      case 'redacted_thinking':
        this.currentTextContent = '';
        this.blocks.push({
          type: 'redacted_thinking',
          id: event.id || `redacted-${Date.now()}`,
          data: event.data || '',
        });
        break;
    }
  }
}
