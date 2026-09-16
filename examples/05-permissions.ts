/**
 * Example 5: Permissions and sandboxing.
 *
 * `canUseTool` maps onto Codex's `item/commandExecution/requestApproval` and
 * `item/fileChange/requestApproval` server requests.
 *
 * Run: npm run example:05
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 5: permissions ---\n')

  const auditLog: Array<{ tool: string; input: unknown; decision: string }> = []

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',

    // Route every approval through one handler.
    canUseTool: async (toolName, input, ctx) => {
      const command = typeof input.command === 'string' ? input.command : ''
      // Deny anything that looks destructive.
      if (/\brm\s+-rf\b|\bsudo\b|\bcurl\b.*\|\s*sh/.test(command)) {
        auditLog.push({ tool: toolName, input, decision: 'deny' })
        return { behavior: 'deny', message: `Blocked dangerous command: ${command}` }
      }
      auditLog.push({ tool: toolName, input, decision: 'allow' })
      return { behavior: 'allow' }
    },
  })

  try {
    const result = await agent.prompt(
      'Run the shell command `pwd` and `ls -la`, then tell me how many entries there are.',
    )
    console.log(result.text)

    console.log('\n--- permission decisions ---')
    for (const entry of auditLog) {
      console.log(`  ${entry.decision.padEnd(5)} ${entry.tool}  ${JSON.stringify(entry.input).slice(0, 80)}`)
    }
    console.log(`\ndenials reported in result: ${JSON.stringify(result.errors ?? [])}`)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
