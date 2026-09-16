/**
 * JSON-RPC client over the Codex app-server transport.
 *
 * The app-server speaks newline-delimited JSON-RPC 2.0. This class owns:
 *  - process/socket lifecycle
 *  - the request/response correlation map
 *  - dispatch of server-initiated requests and notifications
 *  - the framing loop that splits the stream on `\n`
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import { connect as connectSocket, type Socket } from 'node:net'

import {
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  JsonRpcErrorCode,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
} from './protocol/jsonrpc.js'

/** A transport that can carry newline-delimited JSON-RPC frames. */
export interface Transport {
  /** Write one already-serialized JSON message (a newline is appended). */
  write(line: string): void
  /** Close the underlying connection. */
  close(): void
  /** Killed / exited lifecycle signal. */
  onClose(handler: (error?: Error) => void): void
  onError(handler: (error: Error) => void): void
  onLine(handler: (line: string) => void): void
}

/** stdio transport for a spawned `codex app-server` process. */
export class StdioTransport implements Transport {
  private child: ChildProcess
  private rl: Interface | null = null
  private lineHandlers: Array<(line: string) => void> = []
  private closeHandlers: Array<(error?: Error) => void> = []
  private errorHandlers: Array<(error: Error) => void> = []
  private stderrHandlers: Array<(line: string) => void> = []
  private closed = false

  constructor(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (this.child.stdout) {
      this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      this.rl.on('line', (line) => {
        for (const h of this.lineHandlers) h(line)
      })
    }

    // stderr is diagnostic (codex logs there, including model-discovery noise).
    // Surface it separately so callers can log it WITHOUT treating it as a fatal
    // connection error — app-server keeps serving on stdout even when stderr has
    // non-JSON log lines.
    if (this.child.stderr) {
      const errRl = createInterface({ input: this.child.stderr, crlfDelay: Infinity })
      errRl.on('line', (line) => {
        for (const h of this.stderrHandlers) h(line)
      })
    }

    this.child.on('error', (err) => {
      for (const h of this.errorHandlers) h(err)
    })

    this.child.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      const err =
        code === 0 || signal === 'SIGTERM'
          ? undefined
          : new Error(`codex app-server exited with code ${code} (signal ${signal})`)
      for (const h of this.closeHandlers) h(err)
    })
  }

  write(line: string): void {
    if (this.closed || !this.child.stdin) return
    this.child.stdin.write(line + '\n')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rl?.close()
    try {
      this.child.stdin?.end()
      this.child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler)
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler)
  }
  /** Optional diagnostic hook: the spawned process's stderr lines. */
  onStderr(handler: (line: string) => void): void {
    this.stderrHandlers.push(handler)
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler)
  }
}

/** Unix-domain-socket transport for an already running app-server. */
export class UnixSocketTransport implements Transport {
  private socket: Socket
  private buffer = ''
  private lineHandlers: Array<(line: string) => void> = []
  private closeHandlers: Array<(error?: Error) => void> = []
  private errorHandlers: Array<(error: Error) => void> = []
  private closed = false

  constructor(path: string) {
    this.socket = connectSocket(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line) for (const h of this.lineHandlers) h(line)
      }
    })
    this.socket.on('error', (err) => {
      for (const h of this.errorHandlers) h(err)
    })
    this.socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      for (const h of this.closeHandlers) h()
    })
  }

  write(line: string): void {
    if (this.closed) return
    this.socket.write(line + '\n')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.end()
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler)
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler)
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler)
  }
}

/**
 * WebSocket transport for a remote app-server (`codex app-server --listen ws://...`).
 *
 * Framing differs from stdio: one WebSocket Text frame carries exactly one
 * JSON-RPC message — the server does `serde_json::from_str(payload)` per frame
 * and never splits on newlines (see app-server-transport/src/transport/
 * websocket.rs::forward_incoming_message). We still emit/accept via the same
 * `onLine` surface the JsonRpcClient uses, minus any newline handling.
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket
  private messageHandlers: Array<(line: string) => void> = []
  private closeHandlers: Array<(error?: Error) => void> = []
  private errorHandlers: Array<(error: Error) => void> = []
  private closed = false
  private opened: Promise<void>

  constructor(
    url: string,
    options: { headers?: Record<string, string> } = {},
  ) {
    // Node >= 22 exposes the browser-compatible WebSocket global. Header
    // support requires the undici variant; plain `new WebSocket(url)` ignores
    // headers, so warn when they are requested.
    const ws = new WebSocket(url)
    if (options.headers && Object.keys(options.headers).length) {
      // Headers need a custom client; surface a non-fatal warning so users see it.
      const warn = new Error(
        'WebSocketTransport: custom headers are not supported by the global WebSocket client; ' +
          'use an authenticated gateway or a proxy for header injection.',
      )
      setTimeout(() => this.errorHandlers.forEach((h) => h(warn)), 0)
    }
    this.ws = ws

    this.opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener(
        'error',
        () => reject(new Error(`Failed to connect to ${url}`)),
        { once: true },
      )
    })

    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : ''
      for (const h of this.messageHandlers) h(data)
    })

    ws.addEventListener('close', (event) => {
      if (this.closed) return
      this.closed = true
      const err =
        event.code === 1000
          ? undefined
          : new Error(
              `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
            )
      for (const h of this.closeHandlers) h(err)
    })
  }

  /** Resolves once the socket is open. Await before sending to avoid drops. */
  ready(): Promise<void> {
    return this.opened
  }

  write(line: string): void {
    if (this.closed) return
    // One message per frame — no trailing newline (matches server framing).
    this.ws.send(line)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close(1000)
    } catch {
      /* ignore */
    }
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler)
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler)
  }
  onLine(handler: (line: string) => void): void {
    this.messageHandlers.push(handler)
  }
}

/** Events emitted by {@link JsonRpcClient}. */
export interface JsonRpcClientEvents {
  /** A server -> client notification. */
  notification: [notification: JsonRpcNotification]
  /** A server -> client request that needs a response. */
  request: [request: JsonRpcRequest, respond: (result: unknown) => void, fail: (error: JsonRpcErrorObj) => void]
  /** A raw protocol error surfaced by the server or transport. */
  error: [error: Error]
  /** The connection closed. */
  close: [error?: Error]
}

export interface JsonRpcErrorObj {
  code: number
  message: string
  data?: unknown
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
}

/**
 * Correlates request ids, dispatches notifications, and answers server requests.
 */
export class JsonRpcClient extends EventEmitter<JsonRpcClientEvents> {
  private transport: Transport
  private nextId = 1
  private pending = new Map<RequestId, Pending>()
  private closed = false

  constructor(transport: Transport) {
    super()
    this.transport = transport
    this.transport.onLine((line) => this.handleLine(line))
    this.transport.onError((err) => {
      // stderr lines are diagnostics; only report as error events, do not reject pending
      this.emit('error', err)
    })
    this.transport.onClose((err) => {
      this.closed = true
      const err2 = err ?? new Error('app-server connection closed')
      for (const [, p] of this.pending) p.reject(err2)
      this.pending.clear()
      this.emit('close', err)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Send a request and await its result. */
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error('app-server connection is closed'))
    }
    const id = this.nextId++
    const msg: JsonRpcRequest = { id, method, params }
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      })
      try {
        this.transport.write(JSON.stringify(msg))
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { method, params }
    this.transport.write(JSON.stringify(msg))
  }

  /** Reply to a server-initiated request. */
  respond(id: RequestId, result: unknown): void {
    const msg: JsonRpcResponse = { id, result }
    this.transport.write(JSON.stringify(msg))
  }

  /** Fail a server-initiated request. */
  respondError(id: RequestId, error: JsonRpcErrorObj): void {
    const msg = { id, error }
    this.transport.write(JSON.stringify(msg))
  }

  /** Close the transport. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      this.emit('error', new Error(`Failed to parse app-server line: ${trimmed.slice(0, 200)}`))
      return
    }

    if (isResponse(msg)) {
      this.handleResponse(msg)
      return
    }
    if (isRequest(msg)) {
      const respond = (result: unknown) => this.respond(msg.id, result)
      const fail = (error: JsonRpcErrorObj) => this.respondError(msg.id, error)
      this.emit('request', msg, respond, fail)
      return
    }
    if (isNotification(msg)) {
      this.emit('notification', msg)
      return
    }
    this.emit('error', new Error(`Unrecognized app-server message: ${trimmed.slice(0, 200)}`))
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const id = msg.id
    if (id == null) {
      // Null id indicates a server-side parse error with no matching request.
      const message = isErrorResponse(msg) ? msg.error.message : 'unknown error'
      this.emit('error', new Error(`app-server reported an error: ${message}`))
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (isErrorResponse(msg)) {
      const err = new Error(
        `app-server error from ${pending.method} [${msg.error.code}]: ${msg.error.message}`,
      )
      ;(err as Error & { code?: number; data?: unknown }).code = msg.error.code
      ;(err as Error & { code?: number; data?: unknown }).data = msg.error.data
      pending.reject(err)
      return
    }
    pending.resolve(msg.result)
  }
}

/** Build a request with the standard "method not found" shape for replies. */
export function methodNotFound(method: string): JsonRpcErrorObj {
  return {
    code: JsonRpcErrorCode.MethodNotFound,
    message: `Client does not implement ${method}`,
  }
}
