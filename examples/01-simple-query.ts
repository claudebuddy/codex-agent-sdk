/**
 * Example 1: Simple query with streaming.
 *
 * Mirrors `claudebuddy-agent-sdk/examples/01-simple-query.ts` so the two SDKs can
 * be compared side by side.
 *
 * Run: npm run example:01
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 1: Simple query ---\n')

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    permissionMode: 'default',
    maxTurns: 10,
  })

  try {
    for await (const event of agent.query(
      'Read package.json and tell me the project name and version in one sentence.',
    )) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            console.log(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)
          }
          if (block.type === 'text') {
            console.log(`\nassistant: ${block.text}`)
          }
          if (block.type === 'thinking') {
            console.log(`\n[thinking] ${block.thinking.slice(0, 200)}`)
          }
        }
      }

      if (event.type === 'tool_result') {
        console.log(`[result] ${event.result.tool_name}: ${event.result.output.slice(0, 120)}`)
      }

      if (event.type === 'result') {
        console.log(`\n--- result: ${event.subtype} ---`)
        console.log(`turns: ${event.num_turns}  duration: ${event.duration_ms}ms`)
        console.log(`tokens: ${event.usage?.input_tokens} in / ${event.usage?.output_tokens} out`)
      }
    }
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
