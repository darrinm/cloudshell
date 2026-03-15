/**
 * Simplified Agent SDK streaming — no DB, no auth, no sandbox.
 */
import {
  type SDKMessage,
  type SDKUserMessage,
  type ThinkingConfig,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { type SdkContextConfig, extractSessionId, translateSdkEvents } from './agent-events.js';
import type { AgentEvent } from './types.js';

// In-memory session tracking
const sessionMap = new Map<string, string>(); // tabId → sessionId

export function clearSession(tabId: string): void {
  sessionMap.delete(tabId);
}

// Pass through the full environment (minus CLAUDECODE to prevent nested-session errors)
const SDK_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => k !== 'CLAUDECODE' && v !== undefined),
) as Record<string, string>;

export async function* streamAgentSdk(
  tabId: string,
  messages: Array<{ role: string; content: any }>,
  model: string,
  workspaceDir: string,
  signal?: AbortSignal,
  thinking?: ThinkingConfig,
  githubToken?: string,
): AsyncGenerator<AgentEvent> {
  const existingSessionId = sessionMap.get(tabId) || null;

  // Extract last user message
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    yield { type: 'error', message: 'Last message must be from user' };
    yield { type: 'done' };
    return;
  }

  // Resolve content
  let userPrompt: string;
  let hasNonTextContent = false;
  let resolvedContent: any;

  if (typeof lastMsg.content === 'string') {
    userPrompt = lastMsg.content;
    resolvedContent = lastMsg.content;
  } else if (Array.isArray(lastMsg.content)) {
    hasNonTextContent = lastMsg.content.some((p: any) => p.type !== 'text');
    resolvedContent = lastMsg.content;
    userPrompt = lastMsg.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n');
  } else {
    userPrompt = String(lastMsg.content);
    resolvedContent = lastMsg.content;
  }

  // Context config for meter
  const userMessageLength =
    typeof resolvedContent === 'string'
      ? resolvedContent.length
      : (resolvedContent as any[]).reduce((sum: number, p: any) => {
          if (p.type === 'text') return sum + (p.text?.length || 0);
          if (p.type === 'image') return sum + 6400;
          return sum;
        }, 0);
  const contextConfig: SdkContextConfig = { systemPromptLength: 0, userMessageLength };

  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort());
  }

  function buildOptions(resumeSessionId: string | null) {
    return {
      model,
      cwd: workspaceDir,
      abortController,
      includePartialMessages: true,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: {
        ...SDK_ENV,
        HOME: workspaceDir,
        ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
      },
      ...(thinking ? { thinking } : {}),
    };
  }

  function buildPrompt(sessionId: string | null): string | AsyncIterable<SDKUserMessage> {
    if (hasNonTextContent) {
      async function* promptStream(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: resolvedContent },
          parent_tool_use_id: null,
          session_id: sessionId || '',
        } as SDKUserMessage;
      }
      return promptStream();
    }
    return userPrompt;
  }

  let sdkQuery = query({
    prompt: buildPrompt(existingSessionId),
    options: buildOptions(existingSessionId),
  });

  // Fetch slash commands with descriptions from the Query control API
  const slashCommandsPromise = sdkQuery
    .supportedCommands()
    .then((commands) =>
      commands.length > 0
        ? commands.map((c) => ({ name: c.name, description: c.description }))
        : null,
    )
    .catch(() => null);

  const wrappedStream = interceptSessionId(sdkQuery, (sessionId) => {
    sessionMap.set(tabId, sessionId);
  });

  const isStaleSessionError = (msg: string) =>
    msg.includes('No conversation found with session ID');
  let hasRetried = false;

  async function* retryWithoutResume(): AsyncGenerator<AgentEvent> {
    hasRetried = true;
    console.log(`[AGENT-SDK] Stale session, retrying without resume`);
    sessionMap.delete(tabId);
    const freshQuery = query({ prompt: buildPrompt(null), options: buildOptions(null) });
    const freshStream = interceptSessionId(freshQuery, (sessionId) =>
      sessionMap.set(tabId, sessionId),
    );
    yield* translateSdkEvents(freshStream, contextConfig);
  }

  // Check CLI debug log for errors after exit code 1
  function diagnoseExitCode1(): string | null {
    try {
      const debugDir = path.join(workspaceDir, '.claude', 'debug');
      const latestLink = path.join(debugDir, 'latest');
      const debugFile = fs.existsSync(latestLink) ? fs.readlinkSync(latestLink) : null;
      if (!debugFile) return null;
      const content = fs.readFileSync(debugFile, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        if (lines[i].includes('prompt is too long')) {
          const match = lines[i].match(/prompt is too long: (\d+) tokens > (\d+) maximum/);
          if (match)
            return `Context too long (${Math.round(parseInt(match[1]) / 1000)}K tokens). Clear the conversation and start fresh.`;
          return 'Context too long. Clear the conversation and start fresh.';
        }
        if (lines[i].includes('[ERROR]') && lines[i].includes('API error')) {
          return lines[i].replace(/^.*\[ERROR\]\s*/, '');
        }
      }
    } catch {}
    return null;
  }

  try {
    let emittedSlashCommands = false;
    for await (const event of translateSdkEvents(wrappedStream, contextConfig)) {
      if (
        existingSessionId &&
        !hasRetried &&
        event.type === 'error' &&
        typeof event.message === 'string' &&
        isStaleSessionError(event.message)
      ) {
        yield* retryWithoutResume();
        return;
      }
      if (
        event.type === 'error' &&
        typeof event.message === 'string' &&
        event.message.includes('process exited with code 1')
      ) {
        const diagnosis = diagnoseExitCode1();
        if (diagnosis) {
          sessionMap.delete(tabId);
          yield { type: 'error', message: diagnosis };
          yield { type: 'done' };
          return;
        }
      }
      // Replace plain slash_commands with rich version (with descriptions)
      if (event.type === 'slash_commands') {
        const richCommands = await slashCommandsPromise;
        if (richCommands) {
          yield { type: 'slash_commands', commands: richCommands } as AgentEvent;
        } else {
          yield event;
        }
        emittedSlashCommands = true;
        continue;
      }
      // On first content event, emit slash commands if init didn't include them (resumed session)
      if (!emittedSlashCommands && (event.type === 'text' || event.type === 'thinking_start')) {
        const richCommands = await slashCommandsPromise;
        if (richCommands) {
          yield { type: 'slash_commands', commands: richCommands } as AgentEvent;
        }
        emittedSlashCommands = true;
      }
      yield event;
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Client disconnected
    } else if (
      existingSessionId &&
      !hasRetried &&
      error instanceof Error &&
      isStaleSessionError(error.message)
    ) {
      try {
        yield* retryWithoutResume();
        return;
      } catch (retryError) {
        if (retryError instanceof Error && retryError.name === 'AbortError') return;
        yield {
          type: 'error',
          message: retryError instanceof Error ? retryError.message : String(retryError),
        };
      }
    } else if (error instanceof Error && error.message.includes('process exited with code 1')) {
      const diagnosis = diagnoseExitCode1();
      if (diagnosis) {
        sessionMap.delete(tabId);
        yield { type: 'error', message: diagnosis };
      } else {
        yield { type: 'error', message: 'Agent process crashed. Try sending your message again.' };
      }
    } else {
      console.error('[AGENT-SDK] Stream error:', error);
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    yield { type: 'done' };
  }
}

async function* interceptSessionId(
  sdkStream: AsyncIterable<SDKMessage>,
  onSessionId: (id: string) => void,
): AsyncGenerator<SDKMessage> {
  let captured = false;
  for await (const msg of sdkStream) {
    if (!captured) {
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        onSessionId(sessionId);
        captured = true;
      }
    }
    yield msg;
  }
}
