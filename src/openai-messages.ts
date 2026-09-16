/**
 * OpenAI-compatible message loading.
 *
 * zhipinclaw (and most HTTP agent gateways) hand a local agent a standard
 * OpenAI chat request:
 *
 *   POST /v1/chat/completions
 *   { "model": "agent_xxx", "messages": [ {role, content}... ], "stream": true, "session_id" }
 *
 * This module maps that `messages` array onto the SDK's Input so a desktop host
 * can translate an incoming OpenAI request into `createAgent().query(...)`.
 *
 * This is a HOST-side helper (used by the desktop app), not part of the agent
 * loop — the SDK core is unchanged.
 */

import type { ContentBlockParam } from './types.js'

/** A subset of the OpenAI Chat API message shape we care about. */
export type OpenAiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | unknown[] }
  | { role: 'assistant'; content: string | unknown[] | null }
  | { role: 'tool'; tool_call_id: string; content: string }
  | { role: 'function'; content: string | null; name?: string }

export interface OpenAiToInputOptions {
  /** If set, prepended as a system instruction (like OpenAI's system prompt). */
  system?: string
}

/**
 * Convert an OpenAI `messages` array into SDK inputs (`ContentBlockParam[]`).
 *
 * - system messages are folded into a leading instruction block
 * - the final user text becomes the primary prompt
 * - prior turns are preserved as context blocks so the agent sees the history
 *   (the SDK sends the whole array to turn/start, which accepts multiple text
 *   blocks and keeps the thread state)
 */
export function openAiMessagesToInput(
  messages: OpenAiChatMessage[],
  options: OpenAiToInputOptions = {},
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = []

  if (options.system) {
    blocks.push({ type: 'text', text: options.system })
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // Fold system instructions into the prompt text; do not duplicate.
        blocks.push({ type: 'text', text: msg.content })
        break
      case 'user': {
        if (typeof msg.content === 'string') {
          blocks.push({ type: 'text', text: msg.content })
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content as {
            type?: string
            text?: string
            image_url?: string | { url?: string }
          }[]) {
            if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
            else if (part.type === 'image_url' && typeof part.image_url === 'string') {
              blocks.push({ type: 'image', source: { url: part.image_url } })
            } else if (part.type === 'image_url' && typeof part.image_url === 'object' && part.image_url) {
              blocks.push({ type: 'image', source: { url: part.image_url.url } })
            }
          }
        }
        break
      }
      case 'assistant':
        if (typeof msg.content === 'string' && msg.content) {
          blocks.push({ type: 'text', text: msg.content })
        }
        break
      case 'tool':
      case 'function': {
        // Tool outputs are context for the model; fold into a labeled text block.
        const prefix = msg.role === 'tool' ? '[tool result]' : `[function ${msg.name ?? ''}]`
        blocks.push({ type: 'text', text: `${prefix}\n${msg.content ?? ''}` })
        break
      }
      default:
        break
    }
  }

  return blocks
}

/** Compact form: collapse the converted blocks into a single prompt string. */
export function openAiMessagesToPrompt(
  messages: OpenAiChatMessage[],
  options: OpenAiToInputOptions = {},
): string {
  return openAiMessagesToInput(messages, options)
    .map((b) => (b.type === 'text' ? b.text : `[embedded content]`))
    .join('\n\n')
}