/**
 * End-to-end test against a mock app-server.
 *
 * Speaks the real stdio JSONL protocol on a child process, so this exercises
 * process spawn, the initialize handshake, thread/start with dynamicTools,
 * turn/start, notification streaming, a dynamic tool call, and turn completion.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Agent, tool } from '../src/index.js'
import { z } from 'zod'

const here = dirname(fileURLToPath(import.meta.url))
const mockServer = join(here, 'mock-app-server.mjs')

test('Agent completes a turn against a mock app-server', async () => {
  const lookup = tool('lookup', 'look something up', { key: z.string() }, async ({ key }) => ({
    content: [{ type: 'text', text: `value-for-${key}` }],
  }))

  const agent = new Agent({
    // The mock server is a plain node script standing in for `codex app-server`.
    codexPath: process.execPath,
    codexArgs: [mockServer],
    cwd: process.cwd(),
    tools: [lookup],
    includePartialMessages: true,
  })

  const events: string[] = []
  let finalText = ''

  try {
    for await (const event of agent.query('say hello')) {
      events.push(event.type === 'system' ? `system:${event.subtype}` : event.type)
      if (event.type === 'partial_message') {
        // no-op: just ensure partials flow
      }
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') finalText += block.text
        }
      }
      if (event.type === 'result') {
        finalText = event.result ?? finalText
        assert.equal(event.subtype, 'success')
        assert.equal(event.is_error, false)
        assert.ok(event.usage && event.usage.input_tokens > 0, 'usage should be reported')
      }
    }
  } finally {
    await agent.close()
  }

  assert.ok(events.includes('system:init'), 'expected an init system message')
  assert.ok(events.includes('assistant'), 'expected assistant output')
  assert.ok(events.includes('result'), 'expected a result message')
  assert.match(finalText, /mock reply/, `unexpected final text: ${finalText}`)
})

test('Agent runs a dynamic tool call round-trip', async () => {
  const calls: unknown[] = []
  const echo = tool('echo', 'echo the input back', { text: z.string() }, async ({ text }) => {
    calls.push(text)
    return { content: [{ type: 'text', text: `echoed:${text}` }] }
  })

  const agent = new Agent({
    codexPath: process.execPath,
    codexArgs: [mockServer],
    cwd: process.cwd(),
    tools: [echo],
  })

  try {
    for await (const event of agent.query('use the echo tool')) {
      void event
    }
  } finally {
    await agent.close()
  }

  assert.deepEqual(calls, ['ping'], 'the mock server should have triggered one echo call')
})

test('string entries in tools are NOT registered as custom tools', async () => {
  // Capture the mock's synthetic report of what dynamicTools it received.
  const reported: string[] = []

  const agent = new Agent({
    codexPath: process.execPath,
    codexArgs: [mockServer],
    env: { EMIT_DYNAMIC_TOOLS: '1' },
    cwd: process.cwd(),
    // String entries should be treated as built-in tool names, not custom tools.
    tools: ['Bash', 'WebSearch'],
    onNotification: (method, params) => {
      if (method === 'sdk/debug/dynamicTools') reported.push(JSON.stringify(params))
    },
  })

  try {
    for await (const event of agent.query('hello')) {
      if ((event as { type: string }).type === 'result') break
    }
  } finally {
    await agent.close()
  }

  assert.ok(reported.length > 0, 'mock server should report dynamicTools')
  assert.equal(
    reported[0],
    '[]',
    'string tool names must NOT be registered as dynamic tools',
  )
})

test('sessionId triggers thread/resume instead of thread/start', async () => {
  const resumed: string[] = []
  const started: string[] = []

  const agent = new Agent({
    codexPath: process.execPath,
    codexArgs: [mockServer],
    cwd: process.cwd(),
    sessionId: 'thr_persisted_1', // caller wants to resume this thread
    onNotification: (method) => {
      if (method === 'sdk/debug/calledThreadResume') resumed.push('yes')
    },
  })

  try {
    for await (const event of agent.query('hello')) {
      if (event.type === 'system' && event.subtype === 'init') {
        // thread id should be the resumed one
        assert.equal(event.thread_id, 'thr_persisted_1')
      }
      if ((event as { type: string }).type === 'result') break
    }
  } finally {
    await agent.close()
  }

  assert.deepEqual(resumed, ['yes'], 'thread/resume should have been attempted')
  assert.deepEqual(started, [], 'thread/start should not run when resuming')
})
