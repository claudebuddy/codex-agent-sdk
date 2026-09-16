/**
 * Core Codex app-server protocol payloads.
 *
 * Field names are kept in the server's own `camelCase` wire shape so a caller
 * who knows the app-server protocol can pass payloads through unchanged.
 */

import type { RequestId } from './jsonrpc.js'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How the agent asks for approval before running commands / changing files. */
export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: GranularAskForApproval }

export interface GranularAskForApproval {
  mcp_elicitations: boolean
  rules: boolean
  sandbox_approval: boolean
  request_permissions?: boolean
  skill_approval?: boolean
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess?: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots?: string[]
      networkAccess?: boolean
      excludeTmpdirEnvVar?: boolean
      excludeSlashTmp?: boolean
    }
  | { type: 'externalSandbox'; networkAccess?: 'restricted' | 'enabled' }

export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export type CommandExecutionStatus =
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'declined'

export type PatchApplyStatus = 'completed' | 'failed'

export type McpToolCallStatus = 'inProgress' | 'completed' | 'failed'

export type Personality = 'none' | 'friendly' | 'pragmatic'

export type MessagePhase = 'commentary' | 'final_answer'

export type ThreadHistoryMode = 'legacy' | string

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface ClientInfo {
  name: string
  title?: string | null
  version: string
}

export interface InitializeCapabilities {
  /** Opt into experimental methods and fields. */
  experimentalApi?: boolean
  /** MCP extension settings declared by the client. */
  extensions?: Record<string, unknown> | null
  /** Legacy opt-in for the `openai/form` MCP extension. */
  mcpServerOpenaiFormElicitation?: boolean
  /** Exact notification method names to suppress for this connection. */
  optOutNotificationMethods?: string[] | null
  /** Opt into `attestation/generate` requests. */
  requestAttestation?: boolean
}

export interface InitializeParams {
  clientInfo: ClientInfo
  capabilities?: InitializeCapabilities | null
}

export interface InitializeResponse {
  /** Server user agent / version string, when reported. */
  userAgent?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface TextElement {
  byteRange?: { start: number; end: number }
  placeholder?: string
}

export type UserInput =
  | { type: 'text'; text: string; text_elements?: TextElement[] }
  | { type: 'image'; url: string; detail?: ImageDetail | null }
  | { type: 'localImage'; path: string; detail?: ImageDetail | null }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }

export type ImageDetail = 'auto' | 'low' | 'high' | 'original' | string

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export interface GitInfo {
  sha?: string | null
  branch?: string | null
  originUrl?: string | null
}

export interface Thread {
  id: string
  /** Preview text for the conversation, when known. */
  preview?: string | null
  modelProvider: string
  createdAt: number
  updatedAt?: number | null
  cwd: string
  cliVersion: string
  /** Source thread id when this thread was created by forking. */
  forkedFromId?: string | null
  ephemeral: boolean
  gitInfo?: GitInfo | null
  historyMode?: ThreadHistoryMode
  agentNickname?: string | null
  agentRole?: string | null
  name?: string | null
  status?: unknown
  turns?: Turn[]
  [key: string]: unknown
}

export interface ThreadStartParams {
  /** Model id override. */
  model?: string | null
  modelProvider?: string | null
  /** Working directory for the thread. */
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxMode | null
  /** Replaces the base system instructions. */
  baseInstructions?: string | null
  /** Additional developer instructions appended to the prompt. */
  developerInstructions?: string | null
  personality?: Personality | null
  serviceName?: string | null
  serviceTier?: string | null
  /** Threads that are ephemeral are not written to disk. */
  ephemeral?: boolean | null
  /** Raw config.toml overrides applied to this thread. */
  config?: Record<string, unknown> | null
  threadSource?: string | null
  sessionStartSource?: string | null
  /**
   * Client-provided tools the agent can call back into via `item/tool/call`.
   * Requires the `experimentalApi` capability.
   */
  dynamicTools?: DynamicToolSpec[] | null
}

/**
 * A function-style dynamic tool advertised at `thread/start`.
 *
 * Shape mirrors `codex_protocol::dynamic_tools::DynamicToolFunctionSpec`.
 */
export interface DynamicToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
}

export interface ThreadStartResponse {
  thread: Thread
  model: string
  modelProvider: string
  cwd: string
  approvalPolicy: AskForApproval
  approvalsReviewer: ApprovalsReviewer
  sandbox: SandboxPolicy
  reasoningEffort?: string | null
  serviceTier?: string | null
  instructionSources?: string[]
  disabledPluginIds?: string[]
  activePermissionProfile?: ActivePermissionProfile | null
}

export interface ActivePermissionProfile {
  id?: string
  name?: string
  [key: string]: unknown
}

export interface ThreadResumeParams {
  threadId: string
  history?: unknown[] | null
  model?: string | null
  modelProvider?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxMode | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  personality?: Personality | null
  config?: Record<string, unknown> | null
}

export interface ThreadResumeResponse extends ThreadStartResponse {
  /** Turns replayed on resume, when requested. */
  initialTurnsPage?: unknown
}

export interface ThreadForkParams {
  threadId: string
  /** Fork at a turn boundary; omit for the latest state. */
  turnId?: string | null
  cwd?: string | null
  model?: string | null
  modelProvider?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  ephemeral?: boolean | null
}

export interface ThreadForkResponse extends ThreadStartResponse {}

export interface ThreadArchiveParams {
  threadId: string
}
export interface ThreadDeleteParams {
  threadId: string
}
export interface ThreadUnarchiveParams {
  threadId: string
}
export interface ThreadUnsubscribeParams {
  threadId: string
}
export interface ThreadNameSetParams {
  threadId: string
  name: string | null
}

export interface ThreadListParams {
  limit?: number | null
  cursor?: string | null
  archived?: boolean | null
  searchTerm?: string | null
}

export interface ThreadListResponse {
  data: Thread[]
  nextCursor: string | null
}

export interface ThreadReadParams {
  threadId: string
  includeTurns?: boolean | null
}

export interface ThreadReadResponse {
  thread: Thread
}

export interface ThreadCompactStartParams {
  threadId: string
}

export interface ThreadShellCommandParams {
  threadId: string
  command: string
}

export interface ThreadRevertParams {
  threadId: string
  turnId?: string | null
  numTurns?: number | null
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export interface Turn {
  id: string
  items: ThreadItem[]
  itemsView?: string
  status: TurnStatus
  error?: TurnError | null
  startedAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
}

export interface TurnError {
  message: string
  additionalDetails?: string | null
  codexErrorInfo?: unknown
  misalignment?: unknown
}

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  /** Override the model for this turn and subsequent turns. */
  model?: string | null
  /** Override the reasoning effort. */
  effort?: string | null
  /** Override the working directory. */
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandboxPolicy?: SandboxPolicy | null
  personality?: Personality | null
  summary?: string | null
  serviceTier?: string | null
  /** JSON Schema constraining the final assistant message. */
  outputSchema?: unknown
  clientUserMessageId?: string | null
}

export interface TurnStartResponse {
  turn: Turn
}

export interface TurnSteerParams {
  threadId: string
  turnId?: string | null
  input: UserInput[]
}

export interface TurnInterruptParams {
  threadId: string
  turnId?: string | null
}

export interface ReviewStartParams {
  threadId: string
  /** Base branch / commit the review is computed against. */
  base?: string | null
  /** Extra reviewer instructions. */
  instructions?: string | null
}

// ---------------------------------------------------------------------------
// Items — the unit of conversation history
// ---------------------------------------------------------------------------

export interface ThreadItemBase {
  id: string
  type: string
}

export interface UserMessageThreadItem extends ThreadItemBase {
  type: 'userMessage'
  content: UserInput[]
}

export interface AgentMessageThreadItem extends ThreadItemBase {
  type: 'agentMessage'
  text: string
  phase?: MessagePhase | null
  delivery?: 'async' | 'streaming' | null
  memoryCitation?: unknown
  questions?: AsyncUserInputQuestion[] | null
}

export interface HookPromptThreadItem extends ThreadItemBase {
  type: 'hookPrompt'
  hookName?: string
  content?: string
  [key: string]: unknown
}

export interface FunctionCallOutputThreadItem extends ThreadItemBase {
  type: 'functionCallOutput'
  callId?: string
  output?: string
  [key: string]: unknown
}

export interface PlanThreadItem extends ThreadItemBase {
  type: 'plan'
  text: string
}

export interface ReasoningThreadItem extends ThreadItemBase {
  type: 'reasoning'
  summary: string[]
  content: string[]
}

export interface CommandExecutionThreadItem extends ThreadItemBase {
  type: 'commandExecution'
  command: string
  commandActions: CommandAction[]
  cwd: string
  status: CommandExecutionStatus
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
  processId?: string | null
  source?: string
}

export interface CommandAction {
  type: string
  [key: string]: unknown
}

export interface FileUpdateChange {
  path: string
  kind: 'add' | 'delete' | 'update' | string
  diff?: string
}

export interface FileChangeThreadItem extends ThreadItemBase {
  type: 'fileChange'
  changes: FileUpdateChange[]
  status: PatchApplyStatus
}

export interface McpToolCallThreadItem extends ThreadItemBase {
  type: 'mcpToolCall'
  server: string
  tool: string
  arguments: unknown
  status: McpToolCallStatus
  result?: McpToolCallResult | null
  error?: { message: string } | null
  durationMs?: number | null
  pluginId?: string | null
}

export interface McpToolCallResult {
  content: unknown[]
  structuredContent?: unknown
  _meta?: unknown
}

export interface DynamicToolCallThreadItem extends ThreadItemBase {
  type: 'dynamicToolCall'
  tool: string
  arguments?: unknown
  status?: string
  [key: string]: unknown
}

export interface CollabAgentToolCallThreadItem extends ThreadItemBase {
  type: 'collabAgentToolCall'
  [key: string]: unknown
}

export interface SubAgentActivityThreadItem extends ThreadItemBase {
  type: 'subAgentActivity'
  [key: string]: unknown
}

export interface WebSearchThreadItem extends ThreadItemBase {
  type: 'webSearch'
  query: string
}

export interface ImageViewThreadItem extends ThreadItemBase {
  type: 'imageView'
  path?: string
  url?: string
  [key: string]: unknown
}

export interface SleepThreadItem extends ThreadItemBase {
  type: 'sleep'
  durationMs?: number
}

export interface ImageGenerationThreadItem extends ThreadItemBase {
  type: 'imageGeneration'
  [key: string]: unknown
}

export interface EnteredReviewModeThreadItem extends ThreadItemBase {
  type: 'enteredReviewMode'
}

export interface ExitedReviewModeThreadItem extends ThreadItemBase {
  type: 'exitedReviewMode'
}

export interface ContextCompactionThreadItem extends ThreadItemBase {
  type: 'contextCompaction'
}

export type ThreadItem =
  | UserMessageThreadItem
  | HookPromptThreadItem
  | AgentMessageThreadItem
  | FunctionCallOutputThreadItem
  | PlanThreadItem
  | ReasoningThreadItem
  | CommandExecutionThreadItem
  | FileChangeThreadItem
  | McpToolCallThreadItem
  | DynamicToolCallThreadItem
  | CollabAgentToolCallThreadItem
  | SubAgentActivityThreadItem
  | WebSearchThreadItem
  | ImageViewThreadItem
  | SleepThreadItem
  | ImageGenerationThreadItem
  | EnteredReviewModeThreadItem
  | ExitedReviewModeThreadItem
  | ContextCompactionThreadItem

export interface AsyncUserInputQuestion {
  id: string
  question: string
  options?: string[] | null
  allow_multiselect?: boolean
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsageBreakdown {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  cacheWriteInputTokens?: number
  totalTokens: number
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown
  total: TokenUsageBreakdown
  modelContextWindow?: number | null
}

// ---------------------------------------------------------------------------
// Server -> client requests (bidirectional RPC)
// ---------------------------------------------------------------------------

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { [key: string]: unknown } }
  | 'decline'
  | 'cancel'

export interface CommandExecutionRequestApprovalParams {
  itemId: string
  startedAtMs: number
  threadId: string
  turnId: string
  approvalId?: string
  command?: string | null
  commandActions?: CommandAction[] | null
  cwd?: string | null
  reason?: string | null
  kind?: string | null
  proposedExecpolicyAmendment?: string[] | null
}

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision
}

export type FileChangeApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'

export interface FileChangeRequestApprovalParams {
  itemId: string
  startedAtMs: number
  threadId: string
  turnId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision
}

export interface PermissionsRequestApprovalParams {
  itemId: string
  threadId: string
  turnId: string
  permissions?: unknown
  reason?: string | null
}

export interface PermissionsRequestApprovalResponse {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  permissions?: unknown
}

export interface ToolRequestUserInputQuestion {
  id: string
  question: string
  /** Header / short label, when provided. */
  header?: string | null
  options?: Array<{ label: string; description?: string }> | null
  multiSelect?: boolean | null
}

export interface ToolRequestUserInputParams {
  itemId: string
  threadId: string
  turnId: string
  isBlocking: boolean
  questions: ToolRequestUserInputQuestion[]
  autoResolutionMs?: number | null
}

export interface ToolRequestUserInputAnswer {
  answers: string[]
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>
}

export interface DynamicToolCallParams {
  callId: string
  threadId: string
  turnId: string
  tool: string
  arguments: unknown
  namespace?: string | null
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string }

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[]
  success: boolean
}

export interface McpServerElicitationRequestParams {
  serverName: string
  threadId?: string | null
  turnId?: string | null
  requestId?: RequestId
  message: string
  requestedSchema?: unknown
}

export interface McpServerElicitationRequestResponse {
  action: 'accept' | 'decline' | 'cancel'
  content?: unknown
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface ThreadStartedNotification {
  thread: Thread
}

export interface TurnStartedNotification {
  threadId: string
  turn: Turn
}

export interface TurnCompletedNotification {
  threadId: string
  turn: Turn
}

export interface ItemStartedNotification {
  threadId: string
  turnId: string
  item: ThreadItem
  startedAtMs: number
}

export interface ItemCompletedNotification {
  threadId: string
  turnId: string
  item: ThreadItem
  completedAtMs: number
}

export interface AgentMessageDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ReasoningTextDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ReasoningSummaryTextDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface CommandExecutionOutputDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface FileChangePatchUpdatedNotification {
  threadId: string
  turnId: string
  itemId: string
  changes?: FileUpdateChange[]
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string
  turnId: string
  tokenUsage: ThreadTokenUsage
}

export interface ErrorNotification {
  message: string
  codexErrorInfo?: unknown
  additionalDetails?: string | null
}

export interface WarningNotification {
  message: string
}

export interface ServerRequestResolvedNotification {
  requestId: RequestId
}

export interface McpServerStartupStatusUpdatedNotification {
  name: string
  status: string
  error?: string | null
}

export interface TurnPlanUpdatedNotification {
  threadId: string
  turnId: string
  plan?: unknown
}

export interface ThreadCompactedNotification {
  threadId: string
  turnId?: string | null
}
