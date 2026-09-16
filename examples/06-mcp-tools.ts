/**
 * Example 6: External MCP servers + structured output.
 *
 * `mcpServers` are written into the Codex thread config, so the agent can call
 * them with the same tool surface as any other MCP client.
 *
 * Run: npm run example:06
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 6: MCP servers + structured output ---\n')

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    permissionMode: 'default',

    // Declared for reporting purposes; configure real servers via codex config.toml.
    mcpServers: {
      'mysql-mcp-server': { type: 'stdio', command: 'npx', args: ['-y', 'mysql-mcp-server'] },
    },

    // Constrain the final answer to a JSON object.
    outputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['files', 'summary'],
      additionalProperties: false,
    },
  })

  try {
    const result = await agent.prompt(
      'List the top-level TypeScript modules in src/. Respond only with the requested JSON.',
    )

    console.log('raw text:\n', result.text)
    console.log('\nparsed structured output:\n', JSON.stringify(result.structured_output, null, 2))

    const init = agent.getMessages().find((m) => m.type === 'system' && m.subtype === 'init')
    if (init && init.type === 'system' && init.subtype === 'init') {
      console.log(`\nmcp_servers: ${JSON.stringify(init.mcp_servers)}`)
    }
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
