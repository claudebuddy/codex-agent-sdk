/**
 * Tests for the WebSocket transport's framing semantics.
 *
 * Unlike stdio (line-delimited), the app-server's WebSocket transport treats
 * each Text frame as exactly one JSON-RPC message:
 *   inbound  — server does serde_json::from_str(payload) per frame, no line split
 *   outbound — messages are sent as Text frames without trailing newlines
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'

import { JsonRpcClient, WebSocketTransport } from '../src/index.js'

interface MockServer {
  url: string
  /** Raw outbound frames captured on the server side. */
  receivedFrames: string[]
  /** All connected client sockets, for server-initiated pushes. */
  sockets: Set<WsSocket>
  close(): Promise<void>
}

async function startMockServer(
  onMessage: (msg: any, reply: (m: unknown) => void, push: (m: unknown) => void) => void,
): Promise<MockServer> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const receivedFrames: string[] = []
  const sockets = new Set<WsSocket>()

  wss.on('connection', (socket: WsSocket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (data) => {
      const text = data.toString()
      receivedFrames.push(text)
      const msg = JSON.parse(text)
      onMessage(
        msg,
        (reply) => socket.send(JSON.stringify(reply)),
        (notification) => socket.send(JSON.stringify(notification)),
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string') throw new Error('unexpected pipe server')

  return {
    url: `ws://127.0.0.1:${address.port}`,
    receivedFrames,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate()
        wss.close()
        server.close(() => resolve())
      }),
  }
}

test('one frame carries one JSON-RPC message, no newline framing', async () => {
  const server = await startMockServer((msg, reply) => {
    if (msg.method === 'initialize') reply({ id: msg.id, result: { userAgent: 'ws-mock' } })
    if (msg.method === 'thread/start') reply({ id: msg.id, result: { thread: { id: 't1' } } })
  })

  const transport = new WebSocketTransport(server.url)
  const client = new JsonRpcClient(transport)
  await transport.ready()

  const [r1, r2] = await Promise.all([
    client.request('initialize', { clientInfo: { name: 'x', version: '1' } }),
    client.request('thread/start', {}),
  ])

  assert.deepEqual(r1, { userAgent: 'ws-mock' })
  assert.deepEqual(r2, { thread: { id: 't1' } })

  // Outbound frames must be single JSON documents with no newline framing.
  assert.equal(server.receivedFrames.length, 2)
  for (const frame of server.receivedFrames) {
    assert.ok(!frame.includes('\n'), `frame must be a single JSON document: ${frame}`)
    assert.doesNotThrow(() => JSON.parse(frame))
  }

  client.close()
  await server.close()
})

test('server-initiated notifications arrive as single frames and dispatch', async () => {
  const server = await startMockServer((msg, reply, push) => {
    if (msg.method === 'initialize') {
      reply({ id: msg.id, result: {} })
    }
    if (msg.method === 'initialized') {
      push({
        method: 'turn/started',
        params: { threadId: 'th1', turn: { id: 'tu1', items: [], status: 'inProgress' } },
      })
      push({
        method: 'item/agentMessage/delta',
        params: { threadId: 'th1', turnId: 'tu1', itemId: 'i1', delta: 'line1\nline2' },
      })
    }
  })

  const transport = new WebSocketTransport(server.url)
  const client = new JsonRpcClient(transport)
  await transport.ready()

  const notifications: string[] = []
  const deltas: string[] = []
  client.on('notification', (n) => {
    notifications.push(n.method)
    if (n.method === 'item/agentMessage/delta') deltas.push(String(n.params?.delta))
  })

  client.notify('initialized')
  await new Promise((r) => setTimeout(r, 50))

  // Both pushes arrived, each as one frame, embedded newlines intact.
  assert.deepEqual(notifications, ['turn/started', 'item/agentMessage/delta'])
  assert.deepEqual(deltas, ['line1\nline2'])

  client.close()
  await server.close()
})

test('server-initiated requests (reverse RPC) round-trip over WS', async () => {
  const server = await startMockServer((msg, reply, push) => {
    if (msg.method === 'initialize') {
      reply({ id: msg.id, result: {} })
    }
    if (msg.method === 'initialized') {
      push({ id: 77, method: 'item/tool/call', params: { callId: 'c1', tool: 'echo', arguments: { x: 1 } } })
    }
    // The client's response to the reverse request arrives as a new message.
    if (msg.id === undefined && msg.result) {
      // no-op: captured via receivedFrames assertions below
    }
  })

  const transport = new WebSocketTransport(server.url)
  const client = new JsonRpcClient(transport)
  await transport.ready()

  const calls: Array<{ id: number; tool: string }> = []
  client.on('request', (req, respond) => {
    calls.push({ id: req.id as number, tool: String(req.params?.tool) })
    respond({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true })
  })

  client.notify('initialized')
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.tool, 'echo')

  // The client's answer went out as a single frame carrying id + result.
  const responses = server.receivedFrames.map((f) => JSON.parse(f)).filter((m) => m.result)
  assert.equal(responses.length, 1)
  assert.deepEqual(responses[0], {
    id: 77,
    result: { contentItems: [{ type: 'inputText', text: 'ok' }], success: true },
  })

  client.close()
  await server.close()
})
