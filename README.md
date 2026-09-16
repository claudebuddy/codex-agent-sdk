# codex-agent-sdk

A **Claude Agent SDK style TypeScript SDK** built on top of OpenAI Codex's
**app-server JSON-RPC** protocol.

Instead of shelling out to `codex exec --experimental-json` (what the official
`@openai/codex-sdk` does), this SDK speaks the long-lived, bidirectional
**JSON-RPC 2.0** channel of `codex app-server`. That unlocks server→client
requests — approvals, user input, and **client-side tool calls** — plus
fine-grained streaming deltas, interrupt support, and thread lifecycle APIs.

The public surface mirrors the Claude Agent SDK (`claudebuddy-agent-sdk`), so the
same code patterns work: `createAgent()`, `query()`, `agent.prompt()`,
`tool()`, `createSdkMcpServer()`.

---

## Install

```bash
npm install
npm run build
```

Requires a `codex` binary on `PATH` (or pass `codexPath`) — **unless** you
configure a gateway with `baseUrl` + `apiKey`, in which case no ChatGPT login
is needed. Node ≥ 18.

---

## Quick start

```ts
import { createAgent } from '@claudebuddy/codex-agent-sdk'

const agent = createAgent({
  model: 'gpt-5-codex',
  cwd: process.cwd(),
  permissionMode: 'acceptEdits',
})

for await (const event of agent.query('Read package.json and summarize it')) {
  if (event.type === 'assistant') {
    for (const block of event.message.content) {
      if (block.type === 'text') console.log(block.text)
      if (block.type === 'tool_use') console.log(`[tool] ${block.name}`)
    }
  }
  if (event.type === 'result') {
    console.log(`${event.subtype} — ${event.num_turns} turns`)
  }
}

await agent.close()
```

One-shot form:

```ts
import { query } from '@claudebuddy/codex-agent-sdk'

for await (const event of query({ prompt: 'List the files in src/' })) { /* ... */ }
```

---

## Custom gateway (no ChatGPT login required)

Point the SDK at any OpenAI Responses-API-compatible endpoint:

```ts
const agent = createAgent({
  baseUrl: 'https://your-gateway.example.com/v1',
  apiKey: 'sk-...',              // env var also works: CODEX_SDK_API_KEY
  model: 'gpt-5-codex',
})
```

What happens under the hood:

- `baseUrl` + `apiKey` registers a model provider with
  `requires_openai_auth = false` — this is the flag that makes **ChatGPT login
  unnecessary**. The key travels via the `CODEX_SDK_API_KEY` environment
  variable, never on the JSON-RPC wire.
- `baseUrl` alone only overrides `openai_base_url` for the built-in openai
  provider; the normal login flow still applies.
- `gatewayHeaders` adds headers (e.g. `{'X-Gateway': 'abc'}`) to every request.
- `provider` picks the provider id (default `codex-sdk-gateway`).

The same options are accepted by `query()` and `agent.prompt()` overrides.

## Remote app-server (WebSocket / unix socket)

By default the SDK spawns `codex app-server` locally over stdio. To use an
already-running server instead, set `threadOptions.listen`:

```ts
// Remote machine — run `codex app-server --listen ws://0.0.0.0:1450` there.
const agent = createAgent({
  threadOptions: { listen: 'ws://192.168.1.20:1450' },
  model: 'gpt-5-codex',
})

// Local socket — `codex app-server --listen unix:///tmp/codex.sock`.
const agent2 = createAgent({
  threadOptions: { listen: 'unix:///tmp/codex.sock' },
})
```

Framing note: over stdio the protocol is line-delimited JSONL, but over
WebSocket **one Text frame = one JSON-RPC message** (the server parses each
frame with `serde_json::from_str`, no line splitting). The
`WebSocketTransport` handles this for you; a hand-rolled client that appends
`\n` per message will not interoperate.

Remote-server notes:

- The server-side provider must already be configured (e.g. gateway
  `model_providers` in that machine's `config.toml`), or pass gateway config
  via `baseUrl`/`apiKey` — note the key then rides in `thread/start.config`,
  so prefer configuring the remote machine's own env var for secrets.
- `codex app-server` also supports `ws://`, `unix://`, and `stdio://` via
  `--listen`; `off` disables.

## Interface contract (matched to the Claude Agent SDK)

| Claude Agent SDK | This SDK | Notes |
| --- | --- | --- |
| `createAgent(options)` | ✅ same | Returns an {@link Agent} |
| `query({ prompt, options })` | ✅ same | Async generator of `SDKMessage` |
| `agent.query(prompt)` | ✅ same | Streaming generator |
| `agent.prompt(text)` | ✅ same | Resolves `QueryResult` with `.text` |
| `agent.close()` | ✅ same | Kills the app-server process |
| `tool(name, desc, zodShape, handler)` | ✅ same | Returns MCP-shaped `CallToolResult` |
| `createSdkMcpServer({ name, tools })` | ✅ same | Registered as `dynamicTools` |
| `canUseTool(tool, input, ctx)` | ✅ same | Backed by `item/*/requestApproval` |
| `permissionMode` | ✅ same | Mapped onto Codex approval + sandbox |
| `allowedTools` / `disallowedTools` | ✅ same | Short-circuits approval |
| `hooks` | ✅ same | `PreToolUse`, `Stop`, `UserPromptSubmit`, … |
| `outputSchema` / `jsonSchema` | ✅ same | Sets `turn/start.outputSchema` |
| `mcpServers` | ✅ same (config) | Real servers live in `codex` `config.toml` |
| `includePartialMessages` | ✅ same | Enables `partial_message` events |
| `abortController` / `abortSignal` | ✅ same | Issues `turn/interrupt` |
| `maxTurns`, `model`, `cwd`, `env` | ✅ same | |

All names use the snake_case / camelCase mix the Claude Agent SDK exposes
(`input_tokens`, `session_id`, `is_error`, `num_turns`, `total_cost_usd`).

---

## `SDKMessage` mapping

Codex streams *items* (`item/started`, `item/completed`) plus deltas; this SDK
collapses them into the Claude Agent SDK's flat union:

| Codex `ThreadItem` | SDK message |
| --- | --- |
| `agentMessage` | `assistant` with a `text` block |
| `reasoning` | `assistant` with a `thinking` block |
| `commandExecution` | `assistant` `tool_use` (`Bash`) → `tool_result` |
| `fileChange` | `assistant` `tool_use` (`ApplyPatch`) → `tool_result` |
| `mcpToolCall` | `assistant` `tool_use` (`<server>.<tool>`) → `tool_result` |
| `dynamicToolCall` | `assistant` `tool_use` (`<your tool>`) → `tool_result` |
| `webSearch` | `assistant` `tool_use` (`WebSearch`) |
| `contextCompaction` | `system` / `compact_boundary` |
| `item/agentMessage/delta` | `partial_message` (when enabled) |
| `thread/tokenUsage/updated` | `system` / `status` + `result.usage` |
| `turn/completed` | `result` |

---

## Custom tools

> **Do you need `tools` at all?** Usually not. Codex's **built-in tools** —
> `Bash`, `ApplyPatch`, `View`/`Read`, `Grep`, `Glob`, `WebSearch`, etc. — are
> predefined by the app-server and automatically available on every turn. You do
> **not** register them. `tools` is only for **your own** tools.

`tool()` is a drop-in for the Claude Agent SDK helper — same Zod signature, same
`CallToolResult` shape.

```ts
import { z } from 'zod'
import { createAgent, tool } from '@claudebuddy/codex-agent-sdk'

const lookupOrder = tool(
  'lookup_order',
  'Look up an order by id',
  { orderId: z.string().describe('e.g. A-1001') },
  async ({ orderId }) => ({
    content: [{ type: 'text', text: `Order ${orderId}: mechanical keyboard, ¥12800` }],
  }),
  { annotations: { readOnlyHint: true } },
)

const agent = createAgent({ tools: [lookupOrder] })
```

`tools` entries:

- **Object** (`ToolDefinition` / `tool()` result) → registered as a dynamic
  client tool via `thread/start.dynamicTools`, called back through
  `item/tool/call`.
- **String** (e.g. `'Bash'`, `'WebSearch'`) → treated as a *built-in tool name*
  and pre-approved (skips the approval prompt). It does **not** create a
  dynamic tool.

How it works: the tool schema is sent as `thread/start.dynamicTools`, and when
the model calls it the server issues an `item/tool/call` reverse request, which
the SDK dispatches to your handler and returns as `contentItems`.

---

## Permissions

```ts
const agent = createAgent({
  sandboxMode: 'workspace-write',
  canUseTool: async (toolName, input) => {
    if (String(input.command).includes('rm -rf')) {
      return { behavior: 'deny', message: 'blocked destructive command' }
    }
    return { behavior: 'allow' }
  },
})
```

`permissionMode` shortcuts:

| Mode | approvalPolicy | sandbox |
| --- | --- | --- |
| `default` | `on-request` | `workspace-write` |
| `acceptEdits` | `on-request` | `workspace-write` |
| `plan` | `untrusted` | `read-only` |
| `bypassPermissions` | `never` | `danger-full-access` |

Denials are collected into `result.permission_denials`.

---

## Architecture

```
src/
  index.ts             public surface
  agent.ts             Agent class, thread/turn orchestration, approvals
  transport.ts         JSONL JSON-RPC client over stdio / unix socket
  event-mapper.ts      Codex notifications  ->  Claude SDK messages
  tool-helper.ts       tool() (Zod -> JSON Schema)
  sdk-mcp-server.ts    in-process tool registry -> dynamicTools
  types.ts             public SDK types
  protocol/
    methods.ts         101 client methods, 10 server requests, 82 notifications
    types.ts           payload types for threads, turns, items, approvals
    jsonrpc.ts         JSON-RPC 2.0 envelope + type guards
```

**Wire format:** newline-delimited JSON-RPC 2.0 — one JSON object per line, no
`Content-Length` framing.

**Handshake:** `initialize` request → `initialized` notification → `thread/start`.

**Turn loop:** `turn/start` → stream notifications → `turn/completed`.

---

## Protocol reference

Derived directly from `codex-rs/app-server-protocol`. Full JSON Schema is
exported at
`codex/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json`
(639 type definitions).

- **101 client requests** — `thread/*`, `turn/*`, `mcpServer/*`, `config/*`, `fs/*`, `account/*`, …
- **10 server requests** — approvals, `item/tool/call`, elicitation, attestation
- **82 server notifications** — item deltas, turn lifecycle, token usage, account

The whole protocol layer is re-exported for raw access:

```ts
import { JsonRpcClient, ClientMethods, StdioTransport } from '@claudebuddy/codex-agent-sdk'
```

---

## Examples

| File | Shows |
| --- | --- |
| `examples/01-simple-query.ts` | basic streaming |
| `examples/02-multi-turn.ts` | thread persistence across prompts |
| `examples/03-streaming.ts` | deltas, token usage, cancellation |
| `examples/04-custom-tools.ts` | `tool()` + dynamic tool round-trip |
| `examples/05-permissions.ts` | `canUseTool` audit + deny rules |
| `examples/06-mcp-tools.ts` | MCP servers + structured output |
| `examples/07-gateway.ts` | custom gateway endpoint, no login |

```bash
CODEX_MODEL=gpt-5-codex npm run example:01
```

---

## Tests

```bash
npm test        # 22 tests: protocol + mock-app-server e2e + gateway + websocket
npm run build
```

The e2e suite (`tests/e2e.test.ts`) spawns `tests/mock-app-server.mjs`, a real
child process speaking the actual JSONL protocol, and verifies the handshake,
`dynamicTools` registration, streaming, the `item/tool/call` round-trip, and
turn completion — no Codex binary needed.

---

## Differences from the official `@openai/codex-sdk`

| | Official TS SDK | This SDK |
| --- | --- | --- |
| Transport | `codex exec` subprocess, one-shot per turn | `codex app-server` stdio / unix / **ws** |
| Protocol | `--experimental-json` event lines | JSON-RPC 2.0, bidirectional |
| Server→client requests | ❌ | ✅ approvals, user input, tool calls |
| Client-side tools | ❌ (filesystem-defined) | ✅ `tool()` → `dynamicTools` |
| Interrupt | process kill | `turn/interrupt` |
| Thread resume / fork / list | resume only | full lifecycle |
| Streaming granularity | item-level | item + token-level deltas |
| API style | `Thread.run()` | Claude Agent SDK (`agent.query()`) |
