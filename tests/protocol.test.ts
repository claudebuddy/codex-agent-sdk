/**
 * Unit tests for the protocol mapping layer.
 *
 * These run without a Codex binary: they assert the JSON-RPC plumbing and the
 * Codex-notification -> Claude-SDK-message translation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JsonRpcClient,
  mapAgentMessageDelta,
  mapItemToSdkMessage,
  toTokenUsage,
  tool,
} from '../src/index.js'
import type { Transport } from '../src/transport.js'
import type { CommandExecutionThreadItem, ThreadItem } from '../src/protocol/types.js'
import { z } from 'zod'

/** In-memory transport that lets a test act as the app-server. */
class FakeTransport implements Transport {
  readonly sent: string[] = []
  private lineHandlers: Array<(line: string) => void> = []
  private closeHandlers: Array<(error?: Error) => void> = []

  write(line: string): void {
    this.sent.push(line)
  }
  close(): void {
    for (const h of this.closeHandlers) h()
  }
  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler)
  }
  onError(): void {}
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler)
  }

  /** Simulate the server pushing a line to the client. */
  push(message: unknown): void {
    for (const h of this.lineHandlers) h(JSON.stringify(message))
  }
  /** The Nth request the client sent, parsed. */
  request(n = 0): { id: number; method: string; params?: unknown } {
    return JSON.parse(this.sent[n]!) as { id: number; method: string; params?: unknown }
  }
}

test('JsonRpcClient correlates responses by id', async () => {
  const t = new FakeTransport()
  const client = new JsonRpcClient(t)

  const promise = client.request('initialize', { clientInfo: { name: 'x', version: '1' } })
  const req = t.request()
  assert.equal(req.method, 'initialize')

  t.push({ id: req.id, result: { ok: true } })
  assert.deepEqual(await promise, { ok: true })
})

test('JsonRpcClient rejects on JSON-RPC errors', async () => {
  const t = new FakeTransport()
  const client = new JsonRpcClient(t)
  const promise = client.request('turn/start', {})

  const req = t.request()
  t.push({ id: req.id, error: { code: -32602, message: 'bad params' } })

  await assert.rejects(promise, /bad params/)
})

test('JsonRpcClient dispatches notifications and server requests', () => {
  const t = new FakeTransport()
  const client = new JsonRpcClient(t)

  const notifications: string[] = []
  client.on('notification', (n) => notifications.push(n.method))

  const requests: string[] = []
  client.on('request', (req, respond) => {
    requests.push(req.method)
    respond({ decision: 'accept' })
  })

  t.push({ method: 'turn/started', params: {} })
  t.push({ id: 99, method: 'item/commandExecution/requestApproval', params: {} })

  assert.deepEqual(notifications, ['turn/started'])
  assert.deepEqual(requests, ['item/commandExecution/requestApproval'])
  // The response the client wrote back carries the same id.
  const reply = JSON.parse(t.sent.at(-1)!) as { id: number; result: unknown }
  assert.equal(reply.id, 99)
  assert.deepEqual(reply.result, { decision: 'accept' })
})

test('mapItemToSdkMessage renders agentMessage as an assistant text block', () => {
  const item: ThreadItem = { id: 'i1', type: 'agentMessage', text: 'hello' }
  const msgs = mapItemToSdkMessage(item, { threadId: 'th1', completed: true })

  assert.equal(msgs.length, 1)
  const msg = msgs[0]!
  assert.equal(msg.type, 'assistant')
  if (msg.type === 'assistant') {
    assert.deepEqual(msg.message.content, [{ type: 'text', text: 'hello' }])
  }
})

test('mapItemToSdkMessage emits tool_use then tool_result for a command', () => {
  const running: CommandExecutionThreadItem = {
    id: 'c1',
    type: 'commandExecution',
    command: 'pwd',
    commandActions: [],
    cwd: '/tmp',
    status: 'inProgress',
  }
  const started = mapItemToSdkMessage(running, { threadId: 'th1', completed: false })
  assert.equal(started[0]!.type, 'assistant')

  const done: CommandExecutionThreadItem = {
    ...running,
    status: 'completed',
    aggregatedOutput: '/tmp\n',
    exitCode: 0,
  }
  const completed = mapItemToSdkMessage(done, { threadId: 'th1', completed: true })
  assert.equal(completed[0]!.type, 'tool_result')
  if (completed[0]!.type === 'tool_result') {
    assert.equal(completed[0]!.result.tool_name, 'Bash')
    assert.equal(completed[0]!.result.output, '/tmp\n')
    assert.equal(completed[0]!.result.is_error, false)
  }
})

test('mapItemToSdkMessage flags failed commands as errors', () => {
  const item: ThreadItem = {
    id: 'c2',
    type: 'commandExecution',
    command: 'false',
    commandActions: [],
    cwd: '/tmp',
    status: 'failed',
    aggregatedOutput: 'boom',
  }
  const msgs = mapItemToSdkMessage(item, { threadId: 'th1', completed: true })
  if (msgs[0]!.type === 'tool_result') assert.equal(msgs[0]!.result.is_error, true)
})

test('mapItemToSdkMessage maps mcpToolCall into server.tool naming', () => {
  const item: ThreadItem = {
    id: 'm1',
    type: 'mcpToolCall',
    server: 'mysql',
    tool: 'query',
    arguments: { sql: 'select 1' },
    status: 'completed',
    result: { content: [{ type: 'text', text: '1' }], structuredContent: { rows: 1 } },
  }
  const msgs = mapItemToSdkMessage(item, { threadId: 'th1', completed: true })
  if (msgs[0]!.type === 'tool_result') {
    assert.equal(msgs[0]!.result.tool_name, 'mysql.query')
    assert.match(msgs[0]!.result.output, /rows/)
  }
})

test('mapItemToSdkMessage surfaces reasoning as a thinking block', () => {
  const item: ThreadItem = {
    id: 'r1',
    type: 'reasoning',
    summary: ['step one'],
    content: ['step two'],
  }
  const msgs = mapItemToSdkMessage(item, { threadId: 'th1', completed: true })
  if (msgs[0]!.type === 'assistant') {
    const block = msgs[0]!.message.content[0]!
    assert.equal(block.type, 'thinking')
    if (block.type === 'thinking') assert.equal(block.thinking, 'step one\n\nstep two')
  }
})

test('mapItemToSdkMessage drops items with no Claude SDK counterpart', () => {
  const item = { id: 'x1', type: 'sleep', durationMs: 100 } as ThreadItem
  assert.deepEqual(mapItemToSdkMessage(item, { threadId: 'th', completed: true }), [])
})

test('mapAgentMessageDelta produces a partial text event', () => {
  const msg = mapAgentMessageDelta({ itemId: 'a1', delta: 'chunk' })
  assert.equal(msg.type, 'partial_message')
  assert.deepEqual(msg.partial, { type: 'text', id: 'a1', text: 'chunk' })
})

test('toTokenUsage renames Codex accounting fields', () => {
  const usage = toTokenUsage({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 5,
  })
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 5,
  })
})

test('tool() returns an MCP-shaped definition with a working handler', async () => {
  const t = tool(
    'add',
    'Add two numbers',
    { a: z.number(), b: z.number() },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )

  assert.equal(t.name, 'add')
  assert.equal(t.description, 'Add two numbers')
  const result = await t.handler({ a: 2, b: 3 }, {})
  assert.deepEqual(result, { content: [{ type: 'text', text: '5' }] })
})
