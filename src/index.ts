/**
 * codex-agent-sdk
 *
 * A Claude Agent SDK style TypeScript SDK layered on top of the Codex
 * app-server JSON-RPC protocol.
 *
 *   import { createAgent } from '@claudebuddy/codex-agent-sdk'
 *
 *   const agent = createAgent({ model: 'gpt-5-codex', cwd: process.cwd() })
 *   for await (const event of agent.query('Read package.json and summarize it')) {
 *     if (event.type === 'assistant') console.log(event.message.content)
 *   }
 *   await agent.close()
 */

// --------------------------------------------------------------------------
// High-level Agent API (Claude Agent SDK surface)
// --------------------------------------------------------------------------

export { Agent, createAgent, query, buildGatewayConfig } from './agent.js'

// --------------------------------------------------------------------------
// OpenAI-compatible message helpers (host/desktop side)
// --------------------------------------------------------------------------

export {
  openAiMessagesToInput,
  openAiMessagesToPrompt,
} from './openai-messages.js'
export type { OpenAiChatMessage, OpenAiToInputOptions } from './openai-messages.js'

// --------------------------------------------------------------------------
// Tool helper + in-process MCP server
// --------------------------------------------------------------------------

export { tool, sdkToolToJsonSchema } from './tool-helper.js'
export { createSdkMcpServer, isSdkMcpServer, SdkMcpServer } from './sdk-mcp-server.js'

// --------------------------------------------------------------------------
// Transport / low-level JSON-RPC client
// --------------------------------------------------------------------------

export {
  JsonRpcClient,
  StdioTransport,
  UnixSocketTransport,
  WebSocketTransport,
  methodNotFound,
} from './transport.js'
export type { Transport, JsonRpcClientEvents, JsonRpcErrorObj } from './transport.js'

// --------------------------------------------------------------------------
// Event mapping (Codex notification -> Claude SDK message)
// --------------------------------------------------------------------------

export {
  mapItemToSdkMessage,
  mapAgentMessageDelta,
  mapReasoningDelta,
  toTokenUsage,
} from './event-mapper.js'

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type {
  // Options + results
  AgentOptions,
  QueryResult,
  QueryParams,
  // Streaming union
  SDKMessage,
  SDKAssistantMessage,
  SDKToolResultMessage,
  SDKResultMessage,
  SDKPartialMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKTaskNotificationMessage,
  SDKRateLimitEvent,
  // Content
  ContentBlock,
  ContentBlockParam,
  TokenUsage,
  // Tools
  ToolDefinition,
  ToolAnnotations,
  CallToolResult,
  SdkMcpToolDefinition,
  // Permissions
  PermissionMode,
  PermissionBehavior,
  PermissionResult,
  PermissionResult as CanUseToolResult,
  CanUseToolFn,
  CanUseToolContext,
  // MCP
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpSdkServerConfig,
  // Hooks
  HookEvent,
  HookMatcher,
  HookCallback,
  HookCallbackInput,
  HookConfig,
  // Misc
  UserMessageReceipt,
  PendingQuestion,
  QuestionAnswer,
} from './types.js'

// --------------------------------------------------------------------------
// Protocol layer (escape hatch for callers who want raw app-server access)
// --------------------------------------------------------------------------

export * from './protocol/index.js'
