/**
 * In-process MCP server — the Codex analogue of `createSdkMcpServer()`.
 *
 * Codex has no in-process "SDK MCP server" concept: instead the client
 * advertises tools at `thread/start.dynamicTools` and the server calls back with
 * `item/tool/call`. This module bridges the two: a `tool()` definition becomes a
 * dynamic tool spec + a local handler the transport dispatches to.
 */

import type { CallToolResult, SdkMcpToolDefinition } from './types.js'
import { sdkToolToJsonSchema } from './tool-helper.js'
import type { DynamicToolSpec } from './protocol/types.js'

/** A registry of in-process tools that answers server-initiated tool calls. */
export class SdkMcpServer {
  readonly name: string
  readonly version: string
  private tools = new Map<string, SdkMcpToolDefinition>()

  constructor(name: string, version = '1.0.0') {
    this.name = name
    this.version = version
  }

  /** Register one `tool()` definition. */
  addTool(def: SdkMcpToolDefinition): void {
    this.tools.set(def.name, def)
  }

  /** Register many `tool()` definitions at once. */
  addTools(defs: SdkMcpToolDefinition[]): void {
    for (const def of defs) this.addTool(def)
  }

  /** Names of every registered tool. */
  listToolNames(): string[] {
    return [...this.tools.keys()]
  }

  /** Convert every registered tool into a `thread/start.dynamicTools` spec. */
  toDynamicToolSpecs(): DynamicToolSpec[] {
    return [...this.tools.values()].map((def) => {
      const json = sdkToolToJsonSchema(def)
      return {
        name: def.name,
        description: def.description,
        inputSchema: json.input_schema,
      }
    })
  }

  /** True when a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Invoke a registered tool by name.
   * Returns `null` when the tool is unknown so callers can distinguish a miss.
   */
  async invoke(name: string, args: unknown, extra?: unknown): Promise<CallToolResult | null> {
    const def = this.tools.get(name)
    if (!def) return null
    return def.handler(args as never, extra)
  }
}

/** Create an in-process MCP server holding `tool()` definitions. */
export function createSdkMcpServer(options: {
  name: string
  version?: string
  tools?: SdkMcpToolDefinition[]
}): SdkMcpServer {
  const server = new SdkMcpServer(options.name, options.version)
  if (options.tools) server.addTools(options.tools)
  return server
}

/** True when a value is an {@link SdkMcpServer}. */
export function isSdkMcpServer(value: unknown): value is SdkMcpServer {
  return value instanceof SdkMcpServer
}
