// WS message types (client → server)
export interface PtyCreateMessage {
  type: 'pty_create';
  id: string;
  cols: number;
  rows: number;
  command?: string;
  cwd?: string;
}

export interface PtyInputMessage {
  type: 'pty_input';
  id: string;
  data: string; // base64
}

export interface PtyResizeMessage {
  type: 'pty_resize';
  id: string;
  cols: number;
  rows: number;
}

export interface PtyKillMessage {
  type: 'pty_kill';
  id: string;
}

export interface PtyAttachMessage {
  type: 'pty_attach';
  id: string;
  cols: number;
  rows: number;
}

export type ClientMessage =
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyAttachMessage;

// WS message types (server → client)
export interface PtyStartedMessage {
  type: 'pty_started';
  id: string;
}

export interface PtyOutputMessage {
  type: 'pty_output';
  id: string;
  data: string; // base64
}

export interface PtyExitMessage {
  type: 'pty_exit';
  id: string;
  exitCode: number;
}

export interface PtyErrorMessage {
  type: 'pty_error';
  id: string;
  error: string;
}

export interface PtyCwdMessage {
  type: 'pty_cwd';
  id: string;
  name: string;
}

export type ServerMessage = PtyStartedMessage | PtyOutputMessage | PtyExitMessage | PtyErrorMessage | PtyCwdMessage;

// Context meter types
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

// Agent event types (SSE stream)
export interface AgentEvent {
  type:
    | 'text'
    | 'tool_pending'
    | 'tool_call'
    | 'tool_progress'
    | 'tool_result'
    | 'web_search'
    | 'web_search_result'
    | 'web_fetch'
    | 'web_fetch_result'
    | 'error'
    | 'done'
    | 'saved'
    | 'context'
    | 'compacted'
    | 'slash_commands'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_complete'
    | 'redacted_thinking'
    | 'sub_task_start'
    | 'sub_task_progress'
    | 'sub_task_complete'
    | 'agent_tool_progress';
  content?: string;
  id?: string;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  elapsed_time_seconds?: number;
  name?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  message?: string;
  query?: string;
  url?: string;
  title?: string;
  results?: Array<{ url: string; title: string }>;
  usage?: ContextUsage;
  messages?: Array<{ role: string; content: string }>;
  data?: string;
  signature?: string;
  server_name?: string;
  is_error?: boolean;
  taskId?: string;
  prompt?: string;
  model?: string;
  step?: number;
  toolName?: string;
  toolsUsed?: string[];
  toolCallCount?: number;
  error?: string;
  summary?: string;
  duration?: number;
  commands?: Array<{ name: string; description: string }> | string[];
}
