/**
 * Example 4: Custom in-process tools with `tool()`.
 *
 * The `tool()` helper is signature-identical to the Claude Agent SDK. Tools are
 * advertised to the app-server via `thread/start.dynamicTools` and invoked back
 * through `item/tool/call`.
 *
 * Run: npm run example:04
 */
import { z } from 'zod'
import { createAgent, tool } from '../src/index.js'

// A tiny in-memory "database" the tool can read.
const ORDERS: Record<string, { item: string; total: number; status: string }> = {
  'A-1001': { item: 'Mechanical keyboard', total: 12800, status: 'shipped' },
  'A-1002': { item: 'Studio monitor', total: 42000, status: 'processing' },
}

const lookupOrder = tool(
  'lookup_order',
  'Look up an order by its id and return item, total (JPY) and status.',
  { orderId: z.string().describe('Order id, e.g. A-1001') },
  async ({ orderId }) => {
    const order = ORDERS[orderId]
    if (!order) {
      return {
        content: [{ type: 'text', text: `No order found with id ${orderId}` }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: `Order ${orderId}: ${order.item}, ¥${order.total}, status=${order.status}`,
        },
      ],
    }
  },
  { annotations: { readOnlyHint: true } },
)

const countOrders = tool(
  'count_orders',
  'Count orders, optionally filtered by status.',
  { status: z.string().optional().describe('Filter by status; omit for all') },
  async ({ status }) => {
    const all = Object.values(ORDERS)
    const filtered = status ? all.filter((o) => o.status === status) : all
    return { content: [{ type: 'text', text: String(filtered.length) }] }
  },
)

async function main() {
  console.log('--- Example 4: custom tools ---\n')

  const agent = createAgent({
    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    // permissionMode: 'bypassPermissions' lets the shell run unattended.
    permissionMode: 'default',
    tools: [lookupOrder, countOrders],
  })

  try {
    const result = await agent.prompt(
      'Use your tools to look up order A-1002 and count how many orders are processing. ' +
        'Answer with one short sentence.',
    )
    console.log(result.text)
    console.log(`\n(subtype=${result.subtype})`)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
