#!/usr/bin/env node
/**
 * A minimal stand-in for `codex app-server`.
 *
 * Implements just enough of the JSONL JSON-RPC protocol for the SDK's e2e tests:
 *   - initialize / initialized handshake
 *   - thread/start  (echoes back a fake thread)
 *   - turn/start    (streams deltas, drives a dynamic tool call, completes)
 *   - turn/interrupt
 *
 * It also demonstrates that `dynamicTools` sent by the client are what trigger
 * the `item/tool/call` reverse request.
 */

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

let nextTurn = 1
/** dynamicTools advertised by the client, learned at thread/start. */
let dynamicTools = []
let threadId = 'thr_mock_1'
let turnCounter = 0

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function notify(method, params) {
  send({ method, params })
}

function respond(id, result) {
  send({ id, result })
}

function respondError(id, code, message) {
  send({ id, error: { code, message } })
}

/** Fire a request at the client and resolve with its response. */
const pendingServerRequests = new Map()
let nextServerReqId = 1000

function callClient(method, params) {
  const id = nextServerReqId++
  return new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  // Response to one of our server-initiated requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = pendingServerRequests.get(msg.id)
    if (pending) {
      pendingServerRequests.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
    return
  }

  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      respond(id, { userAgent: 'mock-app-server/1.0.0' })
      return

    case 'initialized':
      return

    case 'thread/resume':
      // Emit the method so tests can assert resume was attempted.
      notify('sdk/debug/calledThreadResume', { threadId: params?.threadId ?? null })
      respond(id, {
        thread: {
          id: params?.threadId ?? threadId,
          modelProvider: 'mock',
          createdAt: Math.floor(Date.now() / 1000),
          cwd: params?.cwd ?? process.cwd(),
          cliVersion: '0.0.0-mock',
          ephemeral: false,
        },
        model: params?.model ?? 'gpt-5-codex',
        modelProvider: 'mock',
        cwd: params?.cwd ?? process.cwd(),
        approvalPolicy: params?.approvalPolicy ?? 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      })
      return

    case 'thread/start':
      dynamicTools = params?.dynamicTools ?? []
      // Let the test observe what was registered by emitting it as a synthetic
      // notification using a reserved method.
      if (process.env.EMIT_DYNAMIC_TOOLS) {
        notify('sdk/debug/dynamicTools', dynamicTools)
      }
      respond(id, {
        thread: {
          id: threadId,
          modelProvider: params?.modelProvider ?? 'mock',
          createdAt: Math.floor(Date.now() / 1000),
          cwd: params?.cwd ?? process.cwd(),
          cliVersion: '0.0.0-mock',
          ephemeral: true,
        },
        model: params?.model ?? 'gpt-5-codex',
        modelProvider: params?.modelProvider ?? 'mock',
        cwd: params?.cwd ?? process.cwd(),
        approvalPolicy: params?.approvalPolicy ?? 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      })
      notify('thread/started', {
        thread: {
          id: threadId,
          modelProvider: 'mock',
          createdAt: Math.floor(Date.now() / 1000),
          cwd: params?.cwd ?? process.cwd(),
          cliVersion: '0.0.0-mock',
          ephemeral: true,
        },
      })
      return

    case 'turn/start': {
      turnCounter += 1
      const turnId = `turn_${nextTurn++}`
      const tid = params?.threadId ?? threadId
      runTurn(tid, turnId, params).catch((err) => {
        notify('error', { message: String(err) })
      })
      respond(id, {
        turn: { id: turnId, items: [], status: 'inProgress', itemsView: 'full' },
      })
      return
    }

    case 'turn/interrupt':
      respond(id, {})
      return

    default:
      respondError(id, -32601, `mock does not implement ${method}`)
  }
})

async function runTurn(tid, turnId, params) {
  const base = { threadId: tid, turnId }

  notify('turn/started', {
    threadId: tid,
    turn: { id: turnId, items: [], status: 'inProgress' },
  })

  // 1. Stream an assistant message delta-by-delta.
  const itemId = 'item_msg_1'
  const text = 'mock reply: hello from the fake app-server'
  notify('item/started', {
    ...base,
    item: { id: itemId, type: 'agentMessage', text: '' },
    startedAtMs: Date.now(),
  })

  for (const chunk of chunkString(text, 8)) {
    notify('item/agentMessage/delta', { ...base, itemId, delta: chunk })
    await sleep(2)
  }

  const wantsToolCall = (params?.input ?? []).some(
    (i) => typeof i?.text === 'string' && /echo/i.test(i.text),
  )

  // 2. Drive a dynamic tool call when the prompt asks for it.
  if (wantsToolCall) {
    const toolItem = 'item_tool_1'
    notify('item/started', {
      ...base,
      item: { id: toolItem, type: 'dynamicToolCall', tool: 'echo', arguments: { text: 'ping' }, status: 'inProgress' },
      startedAtMs: Date.now(),
    })

    const res = await callClient('item/tool/call', {
      callId: toolItem,
      threadId: tid,
      turnId,
      tool: 'echo',
      arguments: { text: 'ping' },
    })

    notify('item/completed', {
      ...base,
      item: {
        id: toolItem,
        type: 'dynamicToolCall',
        tool: 'echo',
        arguments: { text: 'ping' },
        status: res?.success ? 'completed' : 'failed',
      },
      completedAtMs: Date.now(),
    })
  }

  // 3. Report token usage.
  notify('thread/tokenUsage/updated', {
    ...base,
    tokenUsage: {
      last: {
        inputTokens: 1234,
        outputTokens: 56,
        cachedInputTokens: 1000,
        reasoningOutputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: 1290,
      },
      total: {
        inputTokens: 1234,
        outputTokens: 56,
        cachedInputTokens: 1000,
        reasoningOutputTokens: 0,
        totalTokens: 1290,
      },
    },
  })

  // 4. Complete the message item and the turn.
  notify('item/completed', {
    ...base,
    item: { id: itemId, type: 'agentMessage', text },
    completedAtMs: Date.now(),
  })

  notify('turn/completed', {
    threadId: tid,
    turn: {
      id: turnId,
      status: 'completed',
      itemsView: 'full',
      items: [{ id: itemId, type: 'agentMessage', text }],
    },
  })
}

function chunkString(value, size) {
  const out = []
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size))
  return out
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
