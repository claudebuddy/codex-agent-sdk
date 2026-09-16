/**
 * 形态 1 真实验证：SDK 默认路径 spawn 本机 codex 的 app-server，走 stdio JSON-RPC，
 * 用真实 ChatGPT 登录态跑一轮 agent 查询。
 * 若通过即证明「只装 codex 就能被 SDK 驱动，无需桌面端」。
 */
import { createAgent } from '../src/index.js'

const CODEX_BIN = process.env.CODEX_BIN // 留空则自动探测（~/.codex/plugins/.plugin-appserver/codex）

async function main() {
  console.log(`codex binary: ${CODEX_BIN || '(auto-detect)'}`)
  console.log('morph 1: SDK spawn local codex app-server via stdio\n')

  // 不配 listen → 走默认 StdioTransport，command 由 resolveCodexCommand 自动解析
  const agent = createAgent({
    ...(CODEX_BIN ? { codexPath: CODEX_BIN } : {}),
    cwd: process.cwd(),
    permissionMode: 'default',
    maxTurns: 5,
    includePartialMessages: true,
  })

  try {
    let finalText = ''
    for await (const event of agent.query('用一句话说：本机 codex 运行正常吗？回答我是的或否，并说明原因。')) {
      if (event.type === 'system' && event.subtype === 'init') {
        console.log(`[init] thread=${event.thread_id} model=${event.model}`)
      }
      if (event.type === 'partial_message' && event.partial.type === 'text') {
        process.stdout.write(event.partial.text ?? '')
      }
      if (event.type === 'assistant') {
        finalText = event.message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
      }
      if (event.type === 'result') {
        console.log(`\n\n--- result: ${event.subtype} (error=${event.is_error}) ---`)
        console.log(`turns=${event.num_turns} usage=${event.usage?.input_tokens}in/${event.usage?.output_tokens}out`)
      }
    }
    console.log('\n[final]', finalText)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err)
  process.exit(1)
})