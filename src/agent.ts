/**
 * The Agent — a Claude Agent SDK style façade over the Codex app-server.
 *
 * Lifecycle:
 *   1. spawn `codex app-server` (stdio, JSONL)
 *   2. `initialize` handshake + `initialized` notification
 *   3. `thread/start` — registering any in-process tools as `dynamicTools`
 *   4. per query: `turn/start`, then stream notifications until `turn/completed`
 *
 * Everything the server asks for (approvals, user input, dynamic tool calls) is
 * answered by handlers supplied through {@link AgentOptions}.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { JsonRpcClient, StdioTransport, UnixSocketTransport, WebSocketTransport, type Transport } from './transport.js'
import { ClientMethods, ServerNotificationMethods, ServerRequestMethods } from './protocol/methods.js'
import type {
  AgentMessageDeltaNotification,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ErrorNotification,
  InitializeParams,
  InitializeResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from './protocol/types.js'
import type { JsonRpcNotification, JsonRpcRequest } from './protocol/jsonrpc.js'
import {
  mapAgentMessageDelta,
  mapItemToSdkMessage,
  mapReasoningDelta,
  toTokenUsage,
} from './event-mapper.js'
import { SdkMcpServer } from './sdk-mcp-server.js'
import type {
  AgentOptions,
  CallToolResult,
  ContentBlockParam,
  HookCallbackInput,
  QueryResult,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  TokenUsage,
  ToolDefinition,
} from './types.js'

const DEFAULT_CLIENT_INFO = { name: 'codex-agent-sdk', title: 'Codex Agent SDK', version: '0.1.0' }

/** Resolve the transport to use, spawning `codex app-server` over stdio by default. */
/**
 * Resolve the `codex` executable to spawn for the stdio transport.
 *
 * Priority:
 *   1. explicit `codexPath`
 *   2. plain `codex` on PATH (spawn resolves it)
 *   3. the app-server plugin binary that the desktop app installs at
 *      `~/.codex/plugins/.plugin-appserver/codex` — so "just installed codex,
 *      no desktop wrapper" works out of the box.
 */
function resolveCodexCommand(explicitPath?: string): string {
  if (explicitPath) return explicitPath
  const desktopBinary = join(
    homedir(),
    '.codex',
    'plugins',
    '.plugin-appserver',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  )
  if (existsSync(desktopBinary)) return desktopBinary
  return 'codex'
}

/** Resolve the transport to use. Priority: ws:// > unix:// > spawn stdio. */
function resolveTransport(options: AgentOptions): Transport {
  const endpoint = options.threadOptions?.listen
  if (typeof endpoint === 'string' && endpoint.startsWith('ws://')) {
    return new WebSocketTransport(endpoint)
  }
  if (typeof endpoint === 'string' && endpoint.startsWith('unix://')) {
    const path = endpoint.slice('unix://'.length) || '/tmp/codex-app-server.sock'
    return new UnixSocketTransport(path)
  }
  const command = resolveCodexCommand(options.codexPath)
  const args = options.codexArgs ?? ['app-server']
  const env: Record<string, string | undefined> = { ...(options.env as Record<string, string | undefined>) }
  // Gateway keys ride in the environment so they never appear on the wire.
  if (options.apiKey) {
    env.CODEX_SDK_API_KEY = options.apiKey
    // For non-spawned transports (unix socket / websocket to an already-running
    // server), export into this process so the server-side env_key lookup
    // finds it — remote servers should be configured with their own env_key.
    if (endpoint) process.env.CODEX_SDK_API_KEY = options.apiKey
  }
  return new StdioTransport(command, args, { cwd: options.cwd, env })
}

/** Normalize a prompt into Codex `UserInput[]`. */
function toUserInput(prompt: string | ContentBlockParam[]): UserInput[] {
  if (typeof prompt === 'string') return [{ type: 'text', text: prompt }]
  const out: UserInput[] = []
  for (const block of prompt) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const source = block.source as { type?: string; path?: string; url?: string; media_type?: string; data?: string } | undefined
      if (source?.path) out.push({ type: 'localImage', path: source.path })
      else if (source?.url) out.push({ type: 'image', url: source.url })
    }
  }
  return out
}

/** Map a Claude-style permission mode onto Codex approval + sandbox settings. */
function resolvePolicy(options: AgentOptions): {
  approvalPolicy: ThreadStartParams['approvalPolicy']
  sandbox: ThreadStartParams['sandbox']
} {
  const mode = options.permissionMode ?? 'default'
  const explicitApproval = options.approvalPolicy
  const explicitSandbox = options.sandboxMode

  let approvalPolicy: ThreadStartParams['approvalPolicy'] = explicitApproval ?? 'on-request'
  let sandbox: ThreadStartParams['sandbox'] = explicitSandbox ?? 'workspace-write'

  if (!explicitApproval) {
    if (mode === 'bypassPermissions') approvalPolicy = 'never'
    else if (mode === 'plan') approvalPolicy = 'untrusted'
  }
  if (!explicitSandbox) {
    if (mode === 'plan') sandbox = 'read-only'
    else if (mode === 'bypassPermissions') sandbox = 'danger-full-access'
  }
  return { approvalPolicy, sandbox }
}

/**
 * A Codex-backed agent session.
 *
 * Mirrors the Claude Agent SDK `Agent`: `query()` streams {@link SDKMessage}s,
 * `prompt()` resolves the final answer, `close()` tears down the connection.
 */
export class Agent {
  private options: AgentOptions
  private client: JsonRpcClient
  private rpc: JsonRpcClient
  private sdkServer: SdkMcpServer
  private plainTools = new Map<string, ToolDefinition>()

  private initialized: Promise<void>
  /** Resolves when the transport is ready to carry the handshake. */
  private transportReady: Promise<void>
  private threadId: string | null
  /** Caller-supplied sessionId to resume (distinct from the live threadId). */
  private initialSessionId: string | null
  private model = 'unknown'

  private messages: SDKMessage[] = []
  private denyCounts: Array<{ tool: string; reason: string }> = []

  private abortCtrl: AbortController | null = null
  private activeTurn: { turnId: string | null; resolve: (t: Turn) => void } | null = null
  private closed = false
  /** Built-in tool names pre-approved via the string form of `options.tools`. */
  private approvedBuiltins = new Set<string>()

  /** Token usage reported by the most recent turn. */
  private lastUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  constructor(options: AgentOptions = {}) {
    this.options = options
    this.sdkServer = new SdkMcpServer('sdk')
    // `sessionId` selects the thread to resume; the live connection is not
    // established until ensureThread() runs (threadId stays null until then).
    this.threadId = null
    this.initialSessionId = options.sessionId ?? null

    // Collect tools supplied directly through options.tools.
    // String entries name *built-in* tools (e.g. 'Bash', 'WebSearch') and are
    // treated as pre-approved aliases — they must NOT be registered as custom
    // tools. Only object definitions (ToolDefinition / tool() results) become
    // dynamic client tools.
    if (Array.isArray(options.tools)) {
      for (const t of options.tools) {
        if (typeof t === 'string') {
          this.approveBuiltin(t)
        } else if (t && typeof (t as ToolDefinition).name === 'string') {
          this.plainTools.set((t as ToolDefinition).name, t as ToolDefinition)
        }
      }
    }

    const transport = resolveTransport(options)
    // WebSocket transports expose a ready() gate; others resolve immediately.
    this.transportReady =
      transport instanceof WebSocketTransport ? transport.ready() : Promise.resolve()

    this.client = new JsonRpcClient(transport)
    // A second reference alias keeps call sites readable; same underlying client.
    this.rpc = this.client

    this.initialized = this.initialize()
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    await this.transportReady

    this.client.on('notification', (n) => this.onNotification(n))
    this.client.on('request', (req, respond, fail) => {
      void this.onServerRequest(req, respond, fail)
    })

    const params: InitializeParams = {
      clientInfo: DEFAULT_CLIENT_INFO,
      capabilities: { experimentalApi: true },
    }
    const res = await this.client.request<InitializeResponse>(ClientMethods.initialize, params)
    if (res && typeof res === 'object' && typeof res.userAgent === 'string') {
      // Server version is informational; keep it for `system` messages.
      ;(this as { serverUserAgent?: string }).serverUserAgent = res.userAgent
    }
    this.client.notify('initialized')
  }

  /** The active thread id, or `null` before the first turn. */
  get sessionId(): string | null {
    return this.threadId
  }

  /** Resolves once the initialize handshake completes. */
  async ready(): Promise<void> {
    await this.initialized
  }

  /** Alias for {@link Agent.sessionId} using Codex terminology. */
  get currentThreadId(): string | null {
    return this.threadId
  }

  /** Every SDK message observed so far this session. */
  getMessages(): SDKMessage[] {
    return [...this.messages]
  }

  // -------------------------------------------------------------------------
  // Thread / turn plumbing
  // -------------------------------------------------------------------------

  private dynamicToolSpecs(): ThreadStartParams['dynamicTools'] {
    // Only object-defined tools become dynamic client tools. String entries in
    // options.tools reference built-in tools and are handled via approveBuiltin().
    const specs = this.sdkServer.toDynamicToolSpecs()
    for (const def of this.plainTools.values()) {
      specs.push({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      })
    }
    return specs.length ? specs : null
  }

  /** Record a built-in tool name (string entry in options.tools) as pre-approved. */
  private approveBuiltin(name: string): void {
    this.approvedBuiltins.add(name)
  }

  /**
   * Compute the provider id and dotted-path config overrides implied by
   * `baseUrl` / `apiKey` gateway options. See {@link buildGatewayConfig}.
   */
  private gatewayConfig(
    opts: AgentOptions,
  ): { providerId: string | null; config: Record<string, unknown> } {
    return buildGatewayConfig(opts)
  }

  private async ensureThread(overrides: Partial<AgentOptions> = {}): Promise<void> {
    if (this.threadId) return
    const opts = { ...this.options, ...overrides }
    const policy = resolvePolicy(opts)
    const gateway = this.gatewayConfig(opts)

    const baseInstructions =
      typeof opts.systemPrompt === 'string'
        ? opts.systemPrompt
        : opts.systemPrompt?.append
          ? opts.systemPrompt.append
          : null
    const developerInstructions =
      opts.appendSystemPrompt ??
      (typeof opts.systemPrompt === 'object' && opts.systemPrompt.append
        ? opts.systemPrompt.append
        : null)

    // The gateway provider wins over opts.modelProvider when both are given.
    const modelProvider = gateway.providerId ?? opts.modelProvider ?? null

    // `listen` selects the transport, not a thread/start param — strip it
    // before spreading threadOptions into the protocol payload.
    const { listen: _listen, ...threadOptions } =
      (opts.threadOptions as Record<string, unknown> | undefined) ?? {}

    const params: ThreadStartParams = {
      model: opts.model ?? null,
      modelProvider,
      cwd: opts.cwd ?? null,
      approvalPolicy: policy.approvalPolicy ?? null,
      sandbox: policy.sandbox ?? null,
      baseInstructions,
      developerInstructions,
      personality: (opts.personality as ThreadStartParams['personality']) ?? null,
      dynamicTools: this.dynamicToolSpecs(),
      ...threadOptions,
    }
    // Merge gateway config last so provider registration is not clobbered.
    if (gateway.config || (threadOptions as { config?: unknown }).config) {
      params.config = {
        ...gateway.config,
        ...((threadOptions as { config?: Record<string, unknown> }).config ?? {}),
      }
    }

    // A caller-provided sessionId means "resume this thread", not "start a new one".
    // Codex persists threads to disk, so we can re-open an existing conversation.
    let res: ThreadStartResponse
    if (this.initialSessionId) {
      try {
        res = await this.client.request<ThreadStartResponse>(ClientMethods.threadResume, {
          threadId: this.initialSessionId,
          model: params.model ?? null,
          modelProvider: params.modelProvider ?? null,
          cwd: params.cwd ?? null,
          approvalPolicy: params.approvalPolicy ?? null,
          sandbox: params.sandbox ?? null,
          baseInstructions: params.baseInstructions ?? null,
          developerInstructions: params.developerInstructions ?? null,
          personality: params.personality ?? null,
          ...(params.config ? { config: params.config } : {}),
        })
      } catch (err) {
        // Thread not found / no longer persisted → fall back to a fresh start.
        res = await this.client.request<ThreadStartResponse>(ClientMethods.threadStart, params)
      }
    } else {
      res = await this.client.request<ThreadStartResponse>(ClientMethods.threadStart, params)
    }
    this.threadId = res.thread.id
    this.model = res.model ?? this.model
    this.emit({
      type: 'system',
      subtype: 'init',
      session_id: this.threadId!,
      thread_id: this.threadId!,
      tools: [
        ...this.sdkServer.listToolNames(),
        ...this.plainTools.keys(),
        ...(Array.isArray(opts.tools) ? opts.tools.filter((t) => typeof t === 'string') : []),
      ],
      model: this.model,
      cwd: res.cwd,
      mcp_servers: Object.keys(opts.mcpServers ?? {}).map((name) => ({ name, status: 'configured' })),
      permission_mode: opts.permissionMode ?? 'default',
    } satisfies SDKSystemMessage)
  }

  // -------------------------------------------------------------------------
  // Public query API
  // -------------------------------------------------------------------------

  /**
   * Send a prompt and stream SDK messages until the turn completes.
   *
   * This is the primary entry point and matches the Claude Agent SDK generator
   * contract: `for await (const event of agent.query('...'))`.
   */
  async *query(
    prompt: string | ContentBlockParam[],
    overrides: Partial<AgentOptions> = {},
  ): AsyncGenerator<SDKMessage, void> {
    if (this.closed) throw new Error('Agent has been closed')
    await this.initialized

    const opts = { ...this.options, ...overrides }
    const ac = opts.abortController ?? new AbortController()
    this.abortCtrl = ac

    const startedAt = Date.now()
    const queue = new MessageQueue<SDKMessage>()
    const resultRef: { turn: Turn | null } = { turn: null }
    const usageRef: { usage: TokenUsage } = { usage: this.lastUsage }
    const turnsBefore = this.turnCount

    // Establish the sink before thread/start so init events are not dropped.
    this.queueSink = queue
    this.currentUsage = usageRef

    let aborted = false
    const onAbort = () => {
      aborted = true
      void this.interrupt().catch(() => undefined)
    }
    ac.signal.addEventListener('abort', onAbort, { once: true })

    let streamError: Error | null = null

    try {
      await this.ensureThread(overrides)
      await this.runHook('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        session_id: this.threadId!,
        thread_id: this.threadId!,
        cwd: opts.cwd ?? process.cwd(),
        prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
      })

      const turnParams: TurnStartParams = {
        threadId: this.threadId!,
        input: toUserInput(prompt),
        model: opts.model ?? null,
        effort: opts.effort ?? null,
        cwd: opts.cwd ?? null,
        outputSchema: opts.outputSchema ?? opts.jsonSchema ?? undefined,
        ...(opts.turnOptions as Record<string, unknown> | undefined),
      }

      this.activeTurn = {
        turnId: null,
        resolve: (turn) => {
          resultRef.turn = turn
        },
      }

      const res = await this.client.request<TurnStartResponse>(ClientMethods.turnStart, turnParams)
      if (this.activeTurn) this.activeTurn.turnId = res.turn.id
      // The turn may already be finished if it was extremely short.
      if (res.turn.status === 'completed' || res.turn.status === 'failed') {
        resultRef.turn = res.turn
        queue.push({ done: true })
      }
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err))
      queue.push({ done: true })
    }

    try {
      while (true) {
        const next = await queue.shift()
        if (next.done) break
        if (next.value !== undefined) yield next.value
      }
    } finally {
      ac.signal.removeEventListener('abort', onAbort)
      this.queueSink = null
      this.activeTurn = null
    }

    const turn = resultRef.turn
    const durationMs = Date.now() - startedAt
    const errors: string[] = []
    let subtype: SDKResultMessage['subtype'] = 'success'
    let isError = false
    const turnsThisQuery = Math.max(1, this.turnCount - turnsBefore)

    if (streamError) {
      subtype = 'error_during_execution'
      isError = true
      errors.push(streamError.message)
    } else if (aborted || turn?.status === 'interrupted') {
      subtype = 'cancelled'
      isError = true
      errors.push('Turn was interrupted')
    } else if (turn?.status === 'failed') {
      subtype = 'error_during_execution'
      isError = true
      if (turn.error?.message) errors.push(turn.error.message)
    } else {
      const maxTurns = opts.maxTurns
      if (maxTurns != null && turnsThisQuery > maxTurns) {
        subtype = 'error_max_turns'
        isError = true
        errors.push(`Reached maxTurns (${maxTurns})`)
      }
    }

    const finalText =
      turn?.items
        ?.filter((i) => i.type === 'agentMessage')
        .map((i) => (i as { text: string }).text)
        .join('') ?? ''

    const resultMsg: SDKResultMessage = {
      type: 'result',
      subtype,
      session_id: this.threadId ?? undefined,
      thread_id: this.threadId ?? undefined,
      is_error: isError,
      num_turns: turnsThisQuery,
      result: finalText,
      stop_reason: turn?.status ?? null,
      total_cost_usd: 0,
      cost: 0,
      duration_ms: durationMs,
      usage: usageRef.usage,
      permission_denials: this.denyCounts.length ? [...this.denyCounts] : undefined,
      structured_output: opts.outputSchema ? tryParseJson(finalText) : undefined,
      errors: errors.length ? errors : undefined,
    }
    this.lastUsage = usageRef.usage
    this.emit(resultMsg)
    yield resultMsg

    await this.runHook('Stop', {
      hook_event_name: 'Stop',
      session_id: this.threadId!,
      thread_id: this.threadId!,
      cwd: opts.cwd ?? process.cwd(),
    })

    if (streamError) throw streamError
  }

  /**
   * Run one prompt and return the final answer, like `agent.prompt()`.
   * Never throws on turn failure; inspect `is_error` / `subtype` instead.
   */
  async prompt(prompt: string | ContentBlockParam[], overrides: Partial<AgentOptions> = {}): Promise<QueryResult> {
    const startedAt = Date.now()
    let output = ''
    let result: SDKResultMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Query ended without a final result'],
    }

    try {
      for await (const event of this.query(prompt, overrides)) {
        if (event.type === 'assistant') {
          const fragments = event.message.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
          if (fragments.length) output = fragments.join('')
        } else if (event.type === 'result') {
          result = event as SDKResultMessage
        }
      }
    } catch (err) {
      result = {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }

    return {
      text: result.result || output,
      subtype: result.subtype,
      is_error: result.is_error ?? result.subtype !== 'success',
      errors: result.errors,
      total_cost_usd: result.total_cost_usd ?? 0,
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      num_turns: result.num_turns ?? 0,
      duration_ms: Math.round(Date.now() - startedAt),
      messages: [...this.messages],
    }
  }

  /** Interrupt the in-flight turn, if any. */
  async interrupt(): Promise<void> {
    if (!this.threadId) return
    const turnId: string | null = this.activeTurn?.turnId ?? null
    try {
      await this.client.request(ClientMethods.turnInterrupt, {
        threadId: this.threadId,
        turnId,
      })
    } catch {
      /* interrupting a finished turn is a no-op */
    }
  }

  /** Close the agent and terminate the app-server process. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.runHook('SessionEnd', {
        hook_event_name: 'SessionEnd',
        session_id: this.threadId ?? '',
        thread_id: this.threadId ?? undefined,
        cwd: this.options.cwd ?? process.cwd(),
      })
    } finally {
      this.client.close()
    }
  }

  // -------------------------------------------------------------------------
  // Notification handling
  // -------------------------------------------------------------------------

  private turnCount = 0
  private queueSink: MessageQueue<SDKMessage> | null = null
  private currentUsage: { usage: TokenUsage } | null = null

  private onNotification(n: JsonRpcNotification): void {
    const { method, params } = n
    this.options.onNotification?.(method, params)
    if (this.options.onRawMessage) this.options.onRawMessage(n)

    switch (method) {
      case ServerNotificationMethods.turnStarted:
        this.turnCount += 1
        break

      case ServerNotificationMethods.itemStarted: {
        const p = params as ItemStartedNotification
        for (const m of mapItemToSdkMessage(p.item, {
          sessionId: this.threadId ?? undefined,
          threadId: p.threadId,
          completed: false,
        })) {
          this.emit(m)
        }
        break
      }

      case ServerNotificationMethods.itemCompleted: {
        const p = params as ItemCompletedNotification
        for (const m of mapItemToSdkMessage(p.item, {
          sessionId: this.threadId ?? undefined,
          threadId: p.threadId,
          completed: true,
        })) {
          this.emit(m)
        }
        break
      }

      case ServerNotificationMethods.agentMessageDelta:
        if (this.options.includePartialMessages) {
          this.emit(mapAgentMessageDelta(params as AgentMessageDeltaNotification))
        }
        break

      case ServerNotificationMethods.reasoningTextDelta:
      case ServerNotificationMethods.reasoningSummaryTextDelta:
        if (this.options.includePartialMessages) {
          this.emit(mapReasoningDelta(params as { itemId: string; delta: string }))
        }
        break

      case ServerNotificationMethods.threadTokenUsageUpdated: {
        const p = params as ThreadTokenUsageUpdatedNotification
        const usage = toTokenUsage(p.tokenUsage.last)
        if (this.currentUsage) this.currentUsage.usage = usage
        this.emit({
          type: 'system',
          subtype: 'status',
          thread_id: p.threadId,
          message: `tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`,
        })
        break
      }

      case ServerNotificationMethods.threadCompacted:
        this.emit({
          type: 'system',
          subtype: 'compact_boundary',
          thread_id: (params as { threadId?: string })?.threadId,
        } as SDKMessage)
        break

      case ServerNotificationMethods.error: {
        const p = params as ErrorNotification
        this.emit({
          type: 'system',
          subtype: 'status',
          message: `error: ${p.message}`,
        })
        break
      }

      case ServerNotificationMethods.turnCompleted: {
        const p = params as TurnCompletedNotification
        if (this.activeTurn) this.activeTurn.resolve(p.turn)
        this.queueSink?.push({ done: true })
        break
      }
    }
  }

  private emit(message: SDKMessage): void {
    this.messages.push(message)
    this.queueSink?.push({ value: message })
  }

  // -------------------------------------------------------------------------
  // Server-initiated requests
  // -------------------------------------------------------------------------

  private async onServerRequest(
    req: JsonRpcRequest,
    respond: (result: unknown) => void,
    fail: (error: { code: number; message: string }) => void,
  ): Promise<void> {
    try {
      switch (req.method) {
        case ServerRequestMethods.commandExecutionApproval: {
          const p = req.params as CommandExecutionRequestApprovalParams
          const decision = await this.decideTool(
            'Bash',
            { command: p.command, cwd: p.cwd },
            { kind: 'commandExecution', threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, raw: p },
          )
          respond({ decision })
          return
        }

        case ServerRequestMethods.fileChangeApproval: {
          const p = req.params as { threadId: string; turnId: string; itemId: string; reason?: string }
          const decision = await this.decideTool(
            'ApplyPatch',
            { reason: p.reason },
            { kind: 'fileChange', threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, raw: p },
          )
          respond({
            decision:
              decision === 'accept' || decision === 'acceptForSession' ? decision : decision === 'cancel' ? 'cancel' : 'decline',
          })
          return
        }

        case ServerRequestMethods.permissionsApproval: {
          const p = req.params as { threadId: string; turnId: string; itemId: string; reason?: string }
          const decision = await this.decideTool(
            'Permissions',
            { reason: p.reason },
            { kind: 'permissions', threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, raw: p },
          )
          respond({
            decision:
              decision === 'accept' || decision === 'acceptForSession' ? decision : decision === 'cancel' ? 'cancel' : 'decline',
          })
          return
        }

        case ServerRequestMethods.dynamicToolCall: {
          const p = req.params as DynamicToolCallParams
          const result = await this.invokeDynamicTool(p)
          respond(result)
          return
        }

        case ServerRequestMethods.toolUserInput: {
          // Without an interactive handler, answer with empty selections so the
          // turn can continue instead of hanging.
          const p = req.params as ToolRequestUserInputParams
          const answers: ToolRequestUserInputResponse['answers'] = {}
          for (const q of p.questions) answers[q.id] = { answers: [] }
          respond({ answers } satisfies ToolRequestUserInputResponse)
          return
        }

        case ServerRequestMethods.mcpElicitation:
          // Decline elicitation by default; servers treat this as "no answer".
          respond({ action: 'decline' })
          return

        default:
          fail({ code: -32601, message: `Unsupported server request: ${req.method}` })
          return
      }
    } catch (err) {
      fail({
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Resolve an approval request into a Codex decision string. */
  private async decideTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: { kind: string; threadId: string; turnId: string; itemId: string; raw: unknown },
  ): Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'> {
    const opts = this.options
    const allowed = opts.allowedTools ?? []
    const denied = opts.disallowedTools ?? []

    if (denied.includes(toolName)) {
      this.denyCounts.push({ tool: toolName, reason: 'matched disallowedTools' })
      return 'decline'
    }
    if (allowed.includes(toolName) || this.approvedBuiltins.has(toolName)) {
      return 'acceptForSession'
    }
    if (opts.permissionMode === 'bypassPermissions') return 'acceptForSession'
    if (opts.permissionMode === 'plan') {
      this.denyCounts.push({ tool: toolName, reason: 'plan mode is read-only' })
      return 'decline'
    }

    if (opts.canUseTool) {
      const verdict = await opts.canUseTool(toolName, input, {
        kind: ctx.kind,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: ctx.itemId,
        raw: ctx.raw,
      })
      if (verdict.behavior === 'allow') return 'accept'
      if (verdict.behavior === 'deny') {
        this.denyCounts.push({ tool: toolName, reason: verdict.message ?? 'denied by canUseTool' })
        return 'decline'
      }
      // `ask` in a non-interactive SDK context is treated as a denial.
      this.denyCounts.push({ tool: toolName, reason: verdict.message ?? 'approval requested but no interactive handler' })
      return 'decline'
    }

    // Default: rely on the thread's approval policy, so accept.
    return 'accept'
  }

  /** Dispatch a server-initiated dynamic tool call to the right handler. */
  private async invokeDynamicTool(p: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const extra = { threadId: p.threadId, turnId: p.turnId, callId: p.callId }
    try {
      if (this.sdkServer.has(p.tool)) {
        const result = await this.sdkServer.invoke(p.tool, p.arguments, extra)
        if (result) return toDynamicToolResponse(result)
      }
      const plain = this.plainTools.get(p.tool)
      if (plain) {
        const result = await plain.handler((p.arguments ?? {}) as Record<string, unknown>, extra)
        return toDynamicToolResponse(result)
      }
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: `Unknown tool: ${p.tool}` }],
      }
    } catch (err) {
      return {
        success: false,
        contentItems: [
          { type: 'inputText', text: `Tool ${p.tool} failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  private async runHook(event: HookCallbackInput['hook_event_name'], input: HookCallbackInput): Promise<void> {
    const matchers = this.options.hooks?.[event]
    if (!matchers?.length) return
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        try {
          await hook(input)
        } catch {
          /* hooks must not break the run */
        }
      }
    }
  }
}

/** Convert an MCP `CallToolResult` into a Codex dynamic tool response. */
function toDynamicToolResponse(result: {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}): DynamicToolCallResponse {
  const contentItems: DynamicToolCallResponse['contentItems'] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      contentItems.push({ type: 'inputText', text: block.text })
    } else if (block.type === 'image' && block.data && block.mimeType) {
      contentItems.push({ type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` })
    }
  }
  if (!contentItems.length) contentItems.push({ type: 'inputText', text: '' })
  return { success: !result.isError, contentItems }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A tiny async queue used to decouple notification callbacks from the generator. */
class MessageQueue<T> {
  private buffer: Array<{ value?: T; done?: boolean }> = []
  private waiters: Array<(item: { value?: T; done?: boolean }) => void> = []

  push(item: { value?: T; done?: boolean }): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.buffer.push(item)
  }

  shift(): Promise<{ value?: T; done?: boolean }> {
    const buffered = this.buffer.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

/**
 * Derive thread config from gateway options.
 *
 * - `baseUrl` + `apiKey`: registers a provider with `requires_openai_auth =
 *   false` — the switch that makes ChatGPT login unnecessary. The key itself
 *   travels in the `CODEX_SDK_API_KEY` environment variable, never on the wire.
 * - `baseUrl` alone: only moves the built-in openai provider to that address
 *   (`openai_base_url`), keeping the normal login flow.
 */
export function buildGatewayConfig(opts: {
  baseUrl?: string
  apiKey?: string
  provider?: string
  gatewayHeaders?: Record<string, string>
}): { providerId: string | null; config: Record<string, unknown> } {
  if (!opts.baseUrl) return { providerId: null, config: {} }
  if (!opts.apiKey) return { providerId: null, config: { openai_base_url: opts.baseUrl } }

  const providerId = opts.provider ?? 'codex-sdk-gateway'
  const config: Record<string, unknown> = {
    model_providers: {
      [providerId]: {
        name: 'SDK gateway',
        base_url: opts.baseUrl,
        requires_openai_auth: false,
        wire_api: 'responses',
        env_key: 'CODEX_SDK_API_KEY',
        ...(opts.gatewayHeaders ? { http_headers: opts.gatewayHeaders } : {}),
      },
    },
  }
  return { providerId, config }
}

// ---------------------------------------------------------------------------
// Factory + one-shot helper
// ---------------------------------------------------------------------------

/** Create an agent. Shorthand for `new Agent(options)`. */
export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}

/**
 * One-shot convenience wrapper: create an agent, run a prompt, then close it.
 *
 *   for await (const event of query({ prompt: 'hi' })) { ... }
 */
export async function* query(params: {
  prompt: string | ContentBlockParam[]
  options?: AgentOptions
}): AsyncGenerator<SDKMessage, void> {
  const agent = createAgent(params.options)
  try {
    await agent.ready()
    yield* agent.query(params.prompt)
  } finally {
    await agent.close()
  }
}
