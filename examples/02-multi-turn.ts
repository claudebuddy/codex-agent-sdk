/**
 * Example 2: Multi-turn conversation on a single thread.
 *
 * Demonstrates session persistence: the thread keeps context across `prompt()`
 * calls, exactly like `claudebuddy-agent-sdk/examples/03-multi-turn.ts`.
 *
 * Run: npm run example:02
 */
import { createAgent } from '../src/index.js'

const tmpFile = '/tmp/codex-agent-sdk-multi-turn.txt'

async function main() {
  console.log('--- Example 2: Multi-turn ---\n')

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    permissionMode: 'acceptEdits',
    maxTurns: 5,
  })

  try {
    console.log(`> Turn 1: create ${tmpFile}`)
    const r1 = await agent.prompt(
      `Use the shell to run: echo "hello from the codex agent sdk" > ${tmpFile}. Confirm briefly.`,
    )
    console.log(`  ${r1.text}  (thread=${agent.sessionId})\n`)

    console.log('> Turn 2: read it back (thread context should persist)')
    const r2 = await agent.prompt(`Read ${tmpFile} and tell me its contents.`)
    console.log(`  ${r2.text}\n`)

    console.log('> Turn 3: clean up')
    const r3 = await agent.prompt(`Delete ${tmpFile} with the shell. Confirm.`)
    console.log(`  ${r3.text}\n`)

    console.log(`total SDK messages observed: ${agent.getMessages().length}`)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
