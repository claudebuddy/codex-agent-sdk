/**
 * Public SDK types.
 *
 * These mirror the Claude Agent SDK / `claudebuddy-agent-sdk` surface so callers
 * can move between them: same `SDKMessage` discriminated union, same
 * `createAgent()` / `query()` / `agent.prompt()` ergonomics, same
 * `tool()` helper returning MCP-shaped `CallToolResult`s.
 */

import type { ZodRawShape, ZodObject } from 'zod'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string }

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean }

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// ---------------------------------------------------------------------------
// SDK messages — the streaming event union
// ---------------------------------------------------------------------------

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid?: string
  session_id?: string
  /** The thread id (Codex terminology) this message belongs to. */
  thread_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  result: {
    tool_use_id: string
    tool_name: string
    output: string
    is_error?: boolean
  }
}

export interface SDKResultMessage {
  type: 'result'
  subtype:
    | 'success'
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'cancelled'
    | string
  uuid?: string
  session_id?: string
  thread_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  permission_denials?: Array<{ tool: string; reason: string }>
  structured_output?: unknown
  errors?: string[]
  /** @deprecated Use total_cost_usd */
  cost?: number
}

export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'tool_use' | 'thinking'
    index?: number
    id?: string
    text?: string
    name?: string
    input?: string
  }
}

export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  thread_id?: string
  tools: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: string
}

export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  thread_id?: string
  summary?: string
}

export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  thread_id?: string
  message: string
}

export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  thread_id?: string
  task_id: string
  status: string
  message?: string
}

export interface SDKRateLimitEvent {
  type: 'system'
  subtype: 'rate_limit'
  thread_id?: string
  retry_after_ms?: number
  message: string
}

export type SDKSystemSubtype =
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent

/** Every event a caller can observe while streaming a query. */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKResultMessage
  | SDKPartialMessage
  | SDKSystemSubtype

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type CallToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text?: string; blob?: string } }
  >
  isError?: boolean
}

/** A `tool()`-created in-process tool. */
export interface SdkMcpToolDefinition<T extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputSchema: ZodObject<T>
  handler: (args: z.infer<ZodObject<T>>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
}

/** A plain, non-Zod tool definition supplied via `options.tools`. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionResult {
  behavior: PermissionBehavior
  /** Set when `behavior` is `deny` (or `ask` in non-interactive mode). */
  message?: string
  /** Optionally rewrite the tool input before it runs. */
  updatedInput?: unknown
}

/** Context handed to {@link CanUseToolFn}. */
export interface CanUseToolContext {
  /** Codex approval kind, e.g. `commandExecution` or `fileChange`. */
  kind: string
  threadId: string
  turnId: string
  itemId: string
  /** The raw approval params from the app-server. */
  raw: unknown
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  context: CanUseToolContext,
) => Promise<PermissionResult> | PermissionResult

// ---------------------------------------------------------------------------
// MCP configuration
// ---------------------------------------------------------------------------

export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSSEServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/** An in-process MCP server built from `tool()` definitions. */
export interface McpSdkServerConfig {
  type: 'sdk'
  name: string
  /** Marker so callers can distinguish SDK servers at runtime. */
  instance?: unknown
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'UserPromptSubmit'

export interface HookCallbackInput {
  hook_event_name: HookEvent
  session_id: string
  thread_id?: string
  cwd: string
  tool_name?: string
  tool_input?: unknown
  tool_output?: unknown
  prompt?: string
}

export type HookCallback = (
  input: HookCallbackInput,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void

export interface HookMatcher {
  matcher?: string
  hooks: HookCallback[]
}

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>

// ---------------------------------------------------------------------------
// Agent options
// ---------------------------------------------------------------------------

export interface AgentOptions {
  // --- Model / runtime -----------------------------------------------------
  /** Codex model id, e.g. `gpt-5-codex`. */
  model?: string
  /** Model provider name configured in codex `config.toml`. */
  modelProvider?: string
  /** Working directory for file and shell tools. */
  cwd?: string
  /** Environment variables injected into the spawned app-server. */
  env?: Record<string, string | undefined>
  /** Path to the `codex` executable. Defaults to `codex` on PATH. */
  codexPath?: string
  /** Extra argv passed to `codex app-server`. */
  codexArgs?: string[]

  // --- Gateway / custom endpoint -------------------------------------------
  /**
   * OpenAI-compatible gateway base URL, e.g. `https://your-proxy.example/v1`.
   *
   * - With {@link apiKey}: registers an SDK-managed provider with
   *   `requires_openai_auth = false`, so **no ChatGPT login is needed**; the key
   *   is passed through the `CODEX_SDK_API_KEY` environment variable.
   * - Without {@link apiKey}: only overrides `openai_base_url` for the built-in
   *   provider, keeping the normal login flow.
   */
  baseUrl?: string
  /**
   * API key for the gateway. When set together with {@link baseUrl}, the SDK
   * skips ChatGPT login entirely and authenticates with this key.
   */
  apiKey?: string
  /**
   * Extra headers appended to every request to a gateway configured via
   * {@link baseUrl} + {@link apiKey}.
   */
  gatewayHeaders?: Record<string, string>
  /**
   * Provider id to select. Defaults to the SDK-managed provider (`codex-sdk-gateway`)
   * when {@link baseUrl} + {@link apiKey} are set.
   */
  provider?: string

  // --- Instructions --------------------------------------------------------
  /** Replace the base system instructions. */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Append to the default system prompt. */
  appendSystemPrompt?: string

  // --- Agent loop ----------------------------------------------------------
  /** Maximum agentic turns per query. */
  maxTurns?: number
  /** Reasoning effort override. */
  effort?: string
  /** Conversational personality. */
  personality?: string

  // --- Permissions / sandbox ----------------------------------------------
  /** Sandbox mode for the thread. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Approval policy for command / file-change requests. */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  /** Permission mode shortcut, mirrors the Claude Agent SDK. */
  permissionMode?: PermissionMode
  /** Programmatic approval handler. */
  canUseTool?: CanUseToolFn
  /** Tool names auto-approved without consulting `canUseTool`. */
  allowedTools?: string[]
  /** Tool names always denied. */
  disallowedTools?: string[]

  // --- Tools ---------------------------------------------------------------
  /** Enable a built-in tool preset. */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** MCP servers to expose to the agent. */
  mcpServers?: Record<string, McpServerConfig | unknown>

  // --- Structured output ---------------------------------------------------
  /** JSON Schema the final assistant message must satisfy. */
  outputSchema?: Record<string, unknown>
  /** Alias for {@link AgentOptions.outputSchema}. */
  jsonSchema?: Record<string, unknown>

  // --- Lifecycle -----------------------------------------------------------
  /** Cancel an in-flight query. */
  abortController?: AbortController
  /** Cancel an in-flight query. */
  abortSignal?: AbortSignal
  /** Emit incremental `partial_message` events. */
  includePartialMessages?: boolean
  /** Hooks keyed by lifecycle event. */
  hooks?: HookConfig
  /** Reuse an existing thread instead of starting a new one. */
  sessionId?: string
  /** Extra thread options passed straight to `thread/start`. */
  threadOptions?: Record<string, unknown>
  /** Extra `turn/start` options. */
  turnOptions?: Record<string, unknown>
  /** Called with the raw app-server message before it is mapped. Primarily for debugging. */
  onRawMessage?: (message: unknown) => void
  /** Called for every server-originated notification. */
  onNotification?: (method: string, params: unknown) => void
}

/** The shape returned by `agent.prompt()`. */
export interface QueryResult {
  text: string
  subtype: string
  is_error: boolean
  errors?: string[]
  total_cost_usd: number
  usage: TokenUsage
  num_turns: number
  duration_ms: number
  messages: SDKMessage[]
}

/** Options accepted by the standalone `query()` helper. */
export interface QueryParams {
  prompt: string | ContentBlockParam[]
  options?: AgentOptions
}

/** Message returned by {@link Agent.sendMessage} for async delivery. */
export interface UserMessageReceipt {
  id: string
  status: 'queued' | 'delivered' | 'failed'
}

export interface PendingQuestion {
  question_id: string
  question: string
  options?: string[]
  allow_multiselect?: boolean
}

export type QuestionAnswer = string | string[]
