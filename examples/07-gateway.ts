/**
 * Example 7: Custom gateway / no-login endpoint.
 *
 * Two flavors:
 *   1. baseUrl + apiKey — a full OpenAI-compatible gateway. No ChatGPT login:
 *      the SDK registers a provider with `requires_openai_auth = false` and
 *      passes the key via the CODEX_SDK_API_KEY environment variable.
 *   2. baseUrl alone — just repoint the built-in openai provider (login still
 *      applies).
 *
 * Run: CODEX_BASE_URL=https://your-gateway/v1 CODEX_API_KEY=sk-xxx npm run example:07
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 7: gateway / no-login ---\n')

  const baseUrl = process.env.CODEX_BASE_URL
  const apiKey = process.env.CODEX_API_KEY

  if (!baseUrl) {
    console.log('Set CODEX_BASE_URL (and optionally CODEX_API_KEY) to run this example.')
    return
  }

  const agent = createAgent({
    // Any OpenAI Responses-API compatible endpoint.
    baseUrl,
    apiKey,
    // Optional extra headers some gateways require.
    gatewayHeaders: process.env.CODEX_GATEWAY_HEADER
      ? { 'X-Gateway': process.env.CODEX_GATEWAY_HEADER }
      : undefined,

    model: process.env.CODEX_MODEL || 'gpt-5-codex',
    cwd: process.cwd(),
    permissionMode: 'default',
  })

  console.log(
    apiKey
      ? 'mode: gateway with key (no ChatGPT login needed)'
      : 'mode: base URL override (normal login flow)',
  )

  try {
    const result = await agent.prompt('Say hi in one short sentence.')
    console.log(result.text)
    console.log(`(thread=${agent.sessionId}, subtype=${result.subtype})`)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
