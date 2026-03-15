/**
 * Translates Claude Agent SDK message stream into AgentEvent stream.
 * Port of Iris's agent-sdk-events.ts with zero Iris dependencies.
 */
import type { SDKMessage, SDKPartialAssistantMessage, SDKAssistantMessage, SDKResultMessage, SDKResultError, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, ContextUsage } from './types.js';

export interface SdkContextConfig {
  systemPromptLength: number;
  userMessageLength: number;
}

interface ToolUseState {
  id: string;
  name: string;
  input: string;
}

export async function* translateSdkEvents(
  sdkStream: AsyncIterable<SDKMessage>,
  contextConfig?: SdkContextConfig,
): AsyncGenerator<AgentEvent> {
  let currentToolUse: ToolUseState | null = null;
  let inTextBlock = false;
  let currentThinkingId: string | null = null;
  let toolTokensAccum = 0;
  let lastContextWindow = 200_000;

  for await (const msg of sdkStream) {
    // Agent subagent tool progress — fires for each inner tool the subagent runs
    if (msg.type === 'system' && (msg as any).subtype === 'task_progress') {
      const tp = msg as any;
      if (tp.tool_use_id) {
        yield { type: 'agent_tool_progress' as const, name: tp.description || '', tool_use_id: tp.tool_use_id };
      }
      continue;
    }

    // Task notification (subagent completed)
    if (msg.type === 'system' && (msg as any).subtype === 'task_notification') {
      const tn = msg as any;
      yield {
        type: 'sub_task_complete' as const,
        tool_use_id: tn.tool_use_id || '',
        summary: tn.summary || '',
        error: tn.status !== 'completed' ? tn.status : undefined,
      };
      continue;
    }

    // Init message: surface slash commands
    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      const commands = (msg as any).slash_commands;
      if (Array.isArray(commands) && commands.length > 0) {
        yield { type: 'slash_commands' as const, commands };
      }
      continue;
    }

    // Compact boundary
    if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
      const preTokens = (msg as any).compact_metadata?.pre_tokens;
      if (contextConfig && typeof preTokens === 'number') {
        yield {
          type: 'context' as const,
          usage: buildSdkContextUsage(preTokens, 0, 0, 0, lastContextWindow, contextConfig, toolTokensAccum),
        };
      }
      yield { type: 'compacted', messages: [] } as any;
      continue;
    }

    // Result message
    if (msg.type === 'result') {
      const result = msg as SDKResultMessage;
      if (((result as any).subtype as string) !== 'success') {
        const errResult = result as SDKResultError;
        const errorMsg = errResult.errors?.length
          ? errResult.errors.join('; ')
          : (errResult.subtype || 'Agent SDK error');
        console.error('[AGENT-SDK] Result error:', errResult.subtype, errResult.errors);
        yield { type: 'error', message: errorMsg };
      }
      if (contextConfig) {
        const usage = (result as any).usage;
        const modelUsage = (result as any).modelUsage;
        if (usage) {
          if (modelUsage) {
            const models = Object.values(modelUsage) as any[];
            if (models[0]?.contextWindow) lastContextWindow = models[0].contextWindow;
          }
          yield {
            type: 'context' as const,
            usage: buildSdkContextUsage(
              usage.input_tokens ?? 0, usage.output_tokens ?? 0,
              usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0,
              lastContextWindow, contextConfig, toolTokensAccum,
            ),
          };
        }
      }
      yield { type: 'done' };
      continue;
    }

    // Complete assistant message
    if (msg.type === 'assistant') {
      const assistantMsg = msg as SDKAssistantMessage;
      if (contextConfig) {
        const usage = (assistantMsg as any).message?.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          yield {
            type: 'context' as const,
            usage: buildSdkContextUsage(
              usage.input_tokens, usage.output_tokens || 0,
              usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0,
              lastContextWindow, contextConfig, toolTokensAccum,
            ),
          };
        }
      }
      continue;
    }

    // User message (tool results)
    if (msg.type === 'user') {
      const userMsg = msg as any;
      if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
        for (const block of userMsg.message.content) {
          if (block.type === 'tool_result') {
            let resultContent: unknown;
            if (typeof block.content === 'string') {
              resultContent = block.content;
            } else if (Array.isArray(block.content)) {
              const texts = block.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text);
              const deduped: string[] = [];
              for (const t of texts) {
                if (!deduped.some(prev => prev.includes(t))) deduped.push(t);
              }
              resultContent = deduped.length === 1 ? deduped[0] : deduped.join('\n');
              if (typeof resultContent === 'string') {
                try { resultContent = JSON.parse(resultContent); } catch {}
              }
            }
            if (contextConfig) {
              const resultStr = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent || '');
              toolTokensAccum += Math.ceil(resultStr.length / 4);
            }
            yield { type: 'tool_result', tool_use_id: block.tool_use_id || '', result: resultContent };
          }
        }
      }
      continue;
    }

    // Streaming partial messages
    if (msg.type === 'stream_event') {
      const partial = msg as SDKPartialAssistantMessage;
      const event = partial.event as any;
      if (!event || !event.type) continue;

      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (!block) break;
          if (block.type === 'text') {
            inTextBlock = true;
          } else if (block.type === 'thinking') {
            const thinkId = block.id || `thinking-${Date.now()}`;
            currentThinkingId = thinkId;
            yield { type: 'thinking_start', id: thinkId };
          } else if (block.type === 'redacted_thinking') {
            yield { type: 'redacted_thinking', id: block.id || `redacted-${Date.now()}`, data: block.data || '' };
          } else if (block.type === 'tool_use') {
            currentToolUse = { id: block.id || '', name: stripMcpPrefix(block.name || ''), input: '' };
            yield { type: 'tool_pending', id: currentToolUse.id, name: currentToolUse.name };
          } else if (block.type === 'server_tool_use') {
            const serverBlock = block as any;
            if (serverBlock.name?.startsWith('web_search')) {
              yield { type: 'web_search', query: '' };
            }
            currentToolUse = { id: serverBlock.id || '', name: serverBlock.name || '', input: '' };
          } else if (block.type === 'web_search_tool_result') {
            const resultBlock = block as any;
            if (Array.isArray(resultBlock.content)) {
              const results = resultBlock.content
                .filter((r: any) => r.type === 'web_search_result')
                .map((r: any) => ({ url: r.url || '', title: r.title || '' }));
              if (results.length > 0) yield { type: 'web_search_result', results };
            }
          } else if (block.type === 'web_fetch_tool_result') {
            const resultBlock = block as any;
            if (resultBlock.content?.type === 'web_fetch_result') {
              yield { type: 'web_fetch_result', url: resultBlock.content.url || '', title: resultBlock.content.content?.title };
            }
          }
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (!delta) break;
          if (delta.type === 'text_delta' && inTextBlock) {
            yield { type: 'text', content: delta.text || '' };
          } else if (delta.type === 'thinking_delta' && currentThinkingId) {
            yield { type: 'thinking_delta', id: currentThinkingId, content: delta.thinking || '' };
          } else if (delta.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.input += delta.partial_json || '';
          }
          break;
        }
        case 'content_block_stop': {
          if (inTextBlock) inTextBlock = false;
          if (currentThinkingId) {
            yield { type: 'thinking_complete', id: currentThinkingId, signature: '' };
            currentThinkingId = null;
          }
          if (currentToolUse) {
            let parsedInput: Record<string, unknown> = {};
            if (currentToolUse.input) {
              try { parsedInput = JSON.parse(currentToolUse.input); } catch {}
              if (contextConfig) toolTokensAccum += Math.ceil(currentToolUse.input.length / 4);
            }
            yield { type: 'tool_call', id: currentToolUse.id, name: currentToolUse.name, input: parsedInput };
            currentToolUse = null;
          }
          break;
        }
      }
    }
  }
}

function buildSdkContextUsage(
  inputTokens: number, outputTokens: number,
  cacheRead: number, cacheCreation: number,
  contextWindow: number, config: SdkContextConfig, toolTokens: number,
): ContextUsage {
  const systemTokensEst = Math.ceil(config.systemPromptLength / 4);
  const promptTokensEst = Math.ceil(config.userMessageLength / 4);
  const agentTokensEst = Math.max(0, inputTokens - systemTokensEst - promptTokensEst - toolTokens);
  return {
    contextWindow, inputTokens, outputTokens,
    systemTokens: systemTokensEst, memoryTokens: 0,
    toolCategories: toolTokens > 0 ? { 'Tools': toolTokens } : {},
    promptTokens: promptTokensEst, agentTokens: agentTokensEst,
    cacheRead, cacheCreation,
  };
}

function stripMcpPrefix(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts.length >= 3 ? parts.slice(2).join('__') : name;
  }
  return name;
}

export function extractSessionId(msg: SDKMessage): string | null {
  if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
    return (msg as SDKSystemMessage).session_id;
  }
  return null;
}
