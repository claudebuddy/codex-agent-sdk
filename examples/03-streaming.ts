/**
 * Example 3: Low-level protocol access.
 *
 * Shows the streaming layer underneath `createAgent()`: notifications, token
 * accounting, reasoning deltas, and cancellation.
 *
 * Run: npm run example:03
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 3: Streaming + cancellation ---\n')

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    permissionMode: 'default',
    includePartialMessages: true,
    // Observe raw app-server notifications for debugging.
    onNotification: (method) => {
      if (process.env.CODEX_SDK_TRACE) console.log(`   [wire] ${method}`)
    },
  })

  const ac = new AbortController()
  // Abort after 20s to demonstrate cancellation semantics.
  const timer = setTimeout(() => {
    console.log('\n[aborting after 20s]')
    ac.abort()
  }, 20_000)

  try {
    for await (const event of agent.query(
      'List the TypeScript files in src/, then summarize what each module does.',
      { abortController: ac },
    )) {
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init') {
            console.log(`[init] model=${event.model} thread=${event.session_id}`)
          } else if (event.subtype === 'status') {
            console.log(`[status] ${event.message}`)
          } else if (event.subtype === 'compact_boundary') {
            console.log('[compaction]')
          }
          break

        case 'partial_message':
          if (event.partial.type === 'text') process.stdout.write(event.partial.text ?? '')
          break

        case 'assistant':
          for (const block of event.message.content) {
            if (block.type === 'tool_use') console.log(`\n[tool] ${block.name}`)
          }
          break

        case 'result':
          console.log(`\n\n--- result: ${event.subtype} (error=${event.is_error}) ---`)
          if (event.errors?.length) console.log(`errors: ${event.errors.join('; ')}`)
          break
      }
    }
  } finally {
    clearTimeout(timer)
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
