# Codex app-server protocol — analysis

Source: `openai/codex` @ `fc269b6`, crates `codex-rs/app-server`,
`codex-rs/app-server-protocol`, `codex-rs/app-server-transport`,
`codex-rs/app-server-client`.

## 1. Repository shape

`codex` is a large Rust workspace (~150 crates under `codex-rs/`) plus a
`codex-cli` npm wrapper and official SDKs for Python and TypeScript.

```
codex/
├── codex-rs/
│   ├── app-server/               server implementation
│   ├── app-server-protocol/      wire types + JSON Schema export  ← authoritative
│   ├── app-server-transport/     stdio / unix socket / websocket
│   ├── app-server-client/        in-repo Rust client
│   ├── app-server-daemon/        managed daemon
│   ├── core/                     agent engine
│   ├── protocol/                 core protocol (includes dynamic_tools)
│   └── ... (~150 crates total)
├── sdk/
│   ├── typescript/               official TS SDK (codex exec based)
│   ├── python/                   official Python SDK
│   └── python-runtime/
└── docs/
```

Crates relevant to this SDK:

| Crate | Why it matters |
| --- | --- |
| `app-server-protocol` | All request/response/notification types. Exports JSON Schema. |
| `app-server` | Handler implementations, `dynamic_tools.rs`, request processors. |
| `app-server-transport` | `stdio.rs` proves the framing is line-delimited. |
| `protocol` | `dynamic_tools.rs` defines the client-tool contract. |

## 2. Framing and handshake

**Framing.** `app-server-transport/src/transport/stdio.rs` reads with
`std::io::stdin().lock().lines()`, and
`serialize_outgoing_message()` does plain `serde_json::to_string` with no
length prefix. So the wire format is **newline-delimited JSON-RPC 2.0**:

```
{"id":1,"method":"initialize","params":{...}}\n
{"id":1,"result":{"userAgent":"..."}}\n
{"method":"initialized"}\n
```

No `Content-Length` header (this is not LSP framing).

**Handshake.** From `app-server-client/src/lib.rs`:

1. client → `initialize` with `InitializeParams { clientInfo, capabilities }`
2. client → `initialized` (notification, no params)
3. client → `thread/start`
4. client → `turn/start` (repeatable)

`InitializeCapabilities`:

| Field | Purpose |
| --- | --- |
| `experimentalApi` | Opt into experimental methods — **required** for `dynamicTools` and elicitation |
| `extensions` | MCP extension declarations |
| `optOutNotificationMethods` | Suppress named notifications on this connection |
| `requestAttestation` | Opt into `attestation/generate` |
| `mcpServerOpenaiFormElicitation` | Legacy `openai/form` opt-in |

**Transports.** `--listen stdio://` (default), `unix://[PATH]`, `ws://IP:PORT`, `off`.
The CLI entry point is `codex app-server`.

## 3. Method inventory

Counts extracted from the exported schema:

| Direction | Count | Schema file |
| --- | --- | --- |
| Client → server requests | **101** | `ClientRequest.json` |
| Server → client requests | **10** | `ServerRequest.json` |
| Server → client notifications | **82** | `ServerNotification.json` |
| Client → server notifications | 1 (`initialized`) | `ClientNotification.json` |

### 3.1 Client → server requests (grouped)

- **Bootstrap** — `initialize`
- **Threads (24)** — `thread/start`, `thread/resume`, `thread/fork`,
  `thread/archive`, `thread/delete`, `thread/unarchive`, `thread/unsubscribe`,
  `thread/name/set`, `thread/metadata/update`, `thread/compact/start`,
  `thread/shellCommand`, `thread/revert`, `thread/list`, `thread/loaded/list`,
  `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/inject_items`,
  `thread/goal/{set,get,clear}`, `thread/attachment/{add,list,remove}`,
  `thread/approveGuardianDeniedAction`, `thread/section/move`
- **Turns (3)** — `turn/start`, `turn/steer`, `turn/interrupt`
- **Review** — `review/start`
- **Models/config** — `model/list`, `modelProvider/capabilities/read`,
  `config/read`, `config/value/write`, `config/batchWrite`,
  `configRequirements/read`, `experimentalFeature/{list,enablement/set}`
- **MCP (5)** — `mcpServerStatus/list`, `mcpServer/resource/read`,
  `mcpServer/tool/call`, `mcpServer/oauth/login`, `config/mcpServer/reload`
- **Skills/plugins** — `skills/list`, `skills/extraRoots/set`,
  `skills/config/write`, `hooks/list`, `plugin/{list,installed,install,uninstall,reconcile,read}`,
  `plugin/skill/read`, `plugin/share/*`, `marketplace/*`, `app/{read,list,installed}`
- **Filesystem (8)** — `fs/readFile`, `fs/writeFile`, `fs/readDirectory`,
  `fs/getMetadata`, `fs/createDirectory`, `fs/remove`, `fs/copy`,
  `fs/{watch,unwatch}`
- **Commands (4)** — `command/exec`, `command/exec/{write,terminate,resize}`
- **Account** — `account/read`, `account/login/{start,cancel}`, `account/logout`,
  `account/rateLimits/read`, `account/rateLimitResetCredit/consume`,
  `account/usage/read`, `account/workspaceMessages/read`
- **Misc** — `fuzzyFileSearch`, `feedback/upload`, `windowsSandbox/*`,
  `externalAgentConfig/*`

### 3.2 Server → client requests (the bidirectional part)

| Method | Params → Response |
| --- | --- |
| `item/commandExecution/requestApproval` | `{itemId, threadId, turnId, command, cwd, reason, kind, proposedExecpolicyAmendment}` → `{decision}` |
| `item/fileChange/requestApproval` | `{itemId, threadId, turnId, reason, grantRoot}` → `{decision}` |
| `item/permissions/requestApproval` | `{itemId, threadId, turnId, permissions}` → `{decision}` |
| `item/tool/requestUserInput` | `{itemId, threadId, turnId, isBlocking, questions[]}` → `{answers}` |
| `item/tool/call` | `{callId, threadId, turnId, tool, arguments, namespace}` → `{contentItems, success}` |
| `mcpServer/elicitation/request` | `{serverName, message, requestedSchema}` → `{action, content}` |
| `account/chatgptAuthTokens/refresh` | token refresh |
| `attestation/generate` | upstream attestation header |
| `applyPatchApproval` / `execCommandApproval` | legacy approval paths |

`CommandExecutionApprovalDecision` ∈ `accept` | `acceptForSession` |
`{acceptWithExecpolicyAmendment}` | `{applyNetworkPolicyAmendment}` | `decline` | `cancel`.

### 3.3 Server → client notifications (grouped)

- **Thread lifecycle** — `thread/started`, `thread/status/changed`,
  `thread/archived`, `thread/deleted`, `thread/unarchived`, `thread/closed`,
  `thread/reverted`, `thread/name/updated`, `thread/compacted`,
  `thread/tokenUsage/updated`, `thread/settings/updated`,
  `thread/attachment/updated`, `thread/goal/{updated,cleared}`,
  `thread/queue/changed`, `thread/environment/{connected,disconnected}`
- **Turn lifecycle** — `turn/started`, `turn/completed`, `turn/diff/updated`,
  `turn/plan/updated`, `turn/moderationMetadata`
- **Items** — `item/started`, `item/completed`, `item/agentMessage/delta`,
  `item/plan/delta`, `item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}`,
  `item/commandExecution/{outputDelta,terminalInteraction}`,
  `item/fileChange/{outputDelta,patchUpdated}`, `item/mcpToolCall/progress`,
  `item/autoApprovalReview/{started,completed}`
- **Account** — `account/updated`, `account/rateLimits/updated`,
  `account/login/completed`
- **MCP** — `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed`,
  `mcpServer/event/stream/notification`, `mcpServer/elicitation/request`
- **Diagnostics** — `error`, `warning`, `guardianWarning`, `deprecationNotice`,
  `configWarning`, `serverRequest/resolved`
- **Filesystem / realtime** — `fs/changed`, `thread/realtime/*` (11 methods),
  `fuzzyFileSearch/session{Updated,Completed}`

## 4. Core payloads

### `thread/start`

`ThreadStartParams`: `model`, `modelProvider`, `cwd`, `approvalPolicy`,
`approvalsReviewer`, `sandbox`, `baseInstructions`, `developerInstructions`,
`personality`, `serviceName`, `serviceTier`, `ephemeral`, `config`,
`threadSource`, `projectId`, **`dynamicTools`**, `environments`,
`selectedCapabilityRoots`.

`ThreadStartResponse`: `thread`, `model`, `modelProvider`, `cwd`,
`approvalPolicy`, `approvalsReviewer`, `sandbox`, `reasoningEffort`,
`instructionSources`, `disabledPluginIds`.

### `turn/start`

`TurnStartParams`: `threadId`*, `input`* (`UserInput[]`), `model`, `effort`,
`cwd`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `personality`,
`summary`, `serviceTier`, `outputSchema`, `clientUserMessageId`.
(* = required)

`UserInput` variants: `text`, `image`, `localImage`, `audio`, `localAudio`,
`skill`.

### `ThreadItem` (19 variants)

`userMessage`, `hookPrompt`, `agentMessage`, `functionCallOutput`, `plan`,
`reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
`collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `sleep`,
`imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`.

Key shapes:

```ts
agentMessage        { id, type, text, phase?: 'commentary'|'final_answer' }
reasoning           { id, type, summary: string[], content: string[] }
commandExecution    { id, type, command, cwd, commandActions[], status,
                      aggregatedOutput?, exitCode?, durationMs? }
fileChange          { id, type, changes: {path, kind}[], status }
mcpToolCall         { id, type, server, tool, arguments, status, result?, error? }
dynamicToolCall     { id, type, tool, arguments, status }
```

Status enums:
`CommandExecutionStatus` = `inProgress | completed | failed | declined`;
`TurnStatus` = `completed | interrupted | failed | inProgress`.

## 5. Client-side tools (`dynamicTools`)

This is the mechanism the SDK's `tool()` helper uses.

`protocol/src/dynamic_tools.rs`:

```rust
pub struct DynamicToolFunctionSpec {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,   // JSON Schema
    pub defer_loading: bool,
}

pub enum DynamicToolSpec {
    Function(DynamicToolFunctionSpec),
    Namespace(DynamicToolNamespaceSpec),
}
```

Flow:

1. Client sends `thread/start` with `dynamicTools: [{name, description, inputSchema}]`
   (requires `experimentalApi`).
2. The model invokes one.
3. Server issues `item/tool/call` back to the client with `{callId, tool, arguments}`.
4. Client responds `{contentItems: [{type:'inputText'|'inputImage'|'inputAudio', ...}], success}`.
5. Server submits the response into the running turn.

Validation lives in `thread_processor.rs::validate_dynamic_tools`.

## 6. Transport choice: app-server vs `codex exec`

The official `sdk/typescript` spawns `codex exec --experimental-json` per turn
and parses a JSONL event stream (`thread.started`, `item.completed`,
`turn.completed`, …). Consequences:

| | `codex exec` | `app-server` |
| --- | --- | --- |
| Connection | new process per turn | one long-lived connection |
| Direction | unidirectional stream | bidirectional JSON-RPC |
| Approvals | policy flags only | server→client requests |
| Custom tools | not supported | `dynamicTools` + `item/tool/call` |
| Interrupt | kill process | `turn/interrupt` |
| Thread ops | resume | full lifecycle (fork/archive/list/read) |

Hence this SDK targets app-server.

## 7. Why app-server for a Claude-Agent-SDK-style surface

Three app-server features have no `codex exec` equivalent and are exactly what
the Claude Agent SDK models:

1. **`canUseTool`** → `item/*/requestApproval` lets the SDK intercept and decide
   per command, with an audit trail and `permission_denials` reporting.
2. **In-process tools** → `dynamicTools` + `item/tool/call` is the analogue of
   `createSdkMcpServer()`.
3. **Interrupt / streaming deltas** → `turn/interrupt` and
   `item/agentMessage/delta` enable true cancellation and token-level partials.

## 8. Reference locations

| What | Path (within the cloned repo) |
| --- | --- |
| Full JSON Schema (639 defs) | `codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json` |
| Per-type schemas (39 files) | `codex-rs/app-server-protocol/schema/json/*.json` |
| Protocol Rust source | `codex-rs/app-server-protocol/src/protocol/v2/*.rs` |
| stdio framing proof | `codex-rs/app-server-transport/src/transport/stdio.rs` |
| Dynamic tool contract | `codex-rs/protocol/src/dynamic_tools.rs` |
| `dynamicTools` validation | `codex-rs/app-server/src/request_processors/thread_processor.rs:291` |
| Official TS SDK (for contrast) | `sdk/typescript/src/{codex,thread,exec,events,items}.ts` |
