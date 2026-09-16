/**
 * Tests for the OpenAI-compatible message mapping helpers.
 * (Host/desktop-side utility — maps OpenAI chat messages to SDK inputs.)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openAiMessagesToInput, openAiMessagesToPrompt } from '../src/index.js'

test('openAiMessagesToInput folds system + user + assistant turns', () => {
  const blocks = openAiMessagesToInput(
    [
      { role: 'system', content: 'you are a coder' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
      { role: 'user', content: 'show me code' },
    ],
    { system: 'override' },
  )

  assert.ok(blocks.length >= 4)
  // system instruction comes first
  assert.deepEqual(blocks[0], { type: 'text', text: 'override' })
  // all blocks are text
  assert.ok(blocks.every((b) => b.type === 'text'))
})

test('openAiMessagesToInput handles image_url parts', () => {
  const blocks = openAiMessagesToInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: 'https://example.com/a.png' },
      ],
    },
  ])

  assert.deepEqual(blocks[0], { type: 'text', text: 'what is this' })
  assert.deepEqual(blocks[1], { type: 'image', source: { url: 'https://example.com/a.png' } })
})

test('openAiMessagesToInput labels tool/function outputs', () => {
  const blocks = openAiMessagesToInput([
    { role: 'user', content: 'run ls' },
    { role: 'assistant', content: null },
    { role: 'tool', tool_call_id: 't1', content: 'file1\nfile2' },
    { role: 'user', content: 'summarize' },
  ])

  const labeled = blocks.find((b) => b.type === 'text' && b.text.startsWith('[tool result]'))
  assert.ok(labeled && labeled.type === 'text' && labeled.text.includes('file1'))
})

test('openAiMessagesToPrompt produces a compact string', () => {
  const prompt = openAiMessagesToPrompt([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ])
  assert.match(prompt, /S/)
  assert.match(prompt, /U/)
})