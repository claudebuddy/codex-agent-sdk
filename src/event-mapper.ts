/**
 * Maps Codex app-server notifications onto Claude Agent SDK style messages.
 *
 * Codex streams items (`item/started` / `item/completed`) plus fine-grained
 * deltas; the Claude Agent SDK streams a flatter `assistant` / `result` /
 * `system` union. This module is the translation layer between the two.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialMessage,
  SDKToolResultMessage,
  TokenUsage,
} from './types.js'
import type {
  AgentMessageThreadItem,
  CommandExecutionThreadItem,
  FileChangeThreadItem,
  McpToolCallThreadItem,
  ReasoningThreadItem,
  ThreadItem,
  WebSearchThreadItem,
} from './protocol/types.js'

/** Escape-free text rendering of a tool result payload. */
function stringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Convert a Codex `ThreadItem` into the closest Claude Agent SDK message.
 *
 * Returns `null` for items that have no meaningful Claude SDK counterpart
 * (internal bookkeeping items), so callers can filter them out.
 */
export function mapItemToSdkMessage(
  item: ThreadItem,
  ctx: { sessionId?: string; threadId?: string; completed: boolean },
): SDKMessage[] {
  switch (item.type) {
    case 'agentMessage': {
      const msg = item as AgentMessageThreadItem
      return [
        {
          type: 'assistant',
          session_id: ctx.sessionId,
          thread_id: ctx.threadId,
          message: { role: 'assistant', content: [{ type: 'text', text: msg.text }] },
        } satisfies SDKAssistantMessage,
      ]
    }

    case 'reasoning': {
      const msg = item as ReasoningThreadItem
      const thinking = [...msg.summary, ...msg.content].filter(Boolean).join('\n\n')
      if (!thinking) return []
      return [
        {
          type: 'assistant',
          session_id: ctx.sessionId,
          thread_id: ctx.threadId,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
        } satisfies SDKAssistantMessage,
      ]
    }

    case 'commandExecution': {
      const msg = item as CommandExecutionThreadItem
      // Announce the tool call once it is first observed.
      const messages: SDKMessage[] = []
      if (!ctx.completed) {
        messages.push({
          type: 'assistant',
          session_id: ctx.sessionId,
          thread_id: ctx.threadId,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: msg.id,
                name: 'Bash',
                input: { command: msg.command, cwd: msg.cwd },
              },
            ],
          },
        } satisfies SDKAssistantMessage)
        return messages
      }
      messages.push({
        type: 'tool_result',
        result: {
          tool_use_id: msg.id,
          tool_name: 'Bash',
          output: msg.aggregatedOutput ?? '',
          is_error: msg.status === 'failed' || msg.status === 'declined',
        },
      } satisfies SDKToolResultMessage)
      return messages
    }

    case 'fileChange': {
      const msg = item as FileChangeThreadItem
      const paths = msg.changes.map((c) => `${c.kind}: ${c.path}`).join('\n')
      if (!ctx.completed) {
        return [
          {
            type: 'assistant',
            session_id: ctx.sessionId,
            thread_id: ctx.threadId,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: msg.id,
                  name: 'ApplyPatch',
                  input: { changes: msg.changes },
                },
              ],
            },
          } satisfies SDKAssistantMessage,
        ]
      }
      return [
        {
          type: 'tool_result',
          result: {
            tool_use_id: msg.id,
            tool_name: 'ApplyPatch',
            output: paths,
            is_error: msg.status === 'failed',
          },
        } satisfies SDKToolResultMessage,
      ]
    }

    case 'mcpToolCall': {
      const msg = item as McpToolCallThreadItem
      const toolName = `${msg.server}.${msg.tool}`
      if (!ctx.completed) {
        return [
          {
            type: 'assistant',
            session_id: ctx.sessionId,
            thread_id: ctx.threadId,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: msg.id, name: toolName, input: msg.arguments },
              ],
            },
          } satisfies SDKAssistantMessage,
        ]
      }
      const output = msg.error
        ? msg.error.message
        : stringify(msg.result?.structuredContent ?? msg.result?.content ?? '')
      return [
        {
          type: 'tool_result',
          result: {
            tool_use_id: msg.id,
            tool_name: toolName,
            output,
            is_error: msg.status === 'failed',
          },
        } satisfies SDKToolResultMessage,
      ]
    }

    case 'dynamicToolCall': {
      const msg = item as unknown as { id: string; tool: string; arguments?: unknown; status?: string }
      const toolName = msg.tool
      if (!ctx.completed) {
        return [
          {
            type: 'assistant',
            session_id: ctx.sessionId,
            thread_id: ctx.threadId,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: msg.id, name: toolName, input: msg.arguments ?? {} },
              ],
            },
          } satisfies SDKAssistantMessage,
        ]
      }
      return [
        {
          type: 'tool_result',
          result: {
            tool_use_id: msg.id,
            tool_name: toolName,
            output: stringify(msg.arguments ?? ''),
            is_error: msg.status === 'failed',
          },
        } satisfies SDKToolResultMessage,
      ]
    }

    case 'webSearch': {
      const msg = item as WebSearchThreadItem
      if (!ctx.completed) {
        return [
          {
            type: 'assistant',
            session_id: ctx.sessionId,
            thread_id: ctx.threadId,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: msg.id, name: 'WebSearch', input: { query: msg.query } },
              ],
            },
          } satisfies SDKAssistantMessage,
        ]
      }
      return []
    }

    case 'contextCompaction':
      return [
        {
          type: 'system',
          subtype: 'compact_boundary',
          thread_id: ctx.threadId,
        } satisfies SDKMessage,
      ]

    default:
      return []
  }
}

/** Build a `partial_message` event from an `item/agentMessage/delta`. */
export function mapAgentMessageDelta(
  params: { itemId: string; delta: string; threadId?: string },
): SDKPartialMessage {
  return {
    type: 'partial_message',
    partial: { type: 'text', id: params.itemId, text: params.delta },
  }
}

/** Build a `partial_message` event from a reasoning text delta. */
export function mapReasoningDelta(
  params: { itemId: string; delta: string },
): SDKPartialMessage {
  return {
    type: 'partial_message',
    partial: { type: 'thinking', id: params.itemId, text: params.delta },
  }
}

/** Convert Codex token accounting into Claude Agent SDK usage fields. */
export function toTokenUsage(breakdown: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
}): TokenUsage {
  return {
    input_tokens: breakdown.inputTokens,
    output_tokens: breakdown.outputTokens,
    cache_read_input_tokens: breakdown.cachedInputTokens ?? 0,
    cache_creation_input_tokens: breakdown.cacheWriteInputTokens ?? 0,
  }
}
