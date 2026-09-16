/**
 * `tool()` helper — Zod-backed tool creation, signature-compatible with the
 * Claude Agent SDK and `claudebuddy-agent-sdk`.
 *
 *   const weather = tool(
 *     'get_weather',
 *     'Get the weather for a city',
 *     { city: z.string().describe('City name') },
 *     async ({ city }) => ({
 *       content: [{ type: 'text', text: `Weather in ${city}: 22C` }],
 *     }),
 *   )
 */

import { z, type ZodRawShape, type ZodObject } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
  CallToolResult,
  SdkMcpToolDefinition,
  ToolAnnotations,
} from './types.js'

/**
 * Create a tool from a Zod raw shape.
 *
 * Returns an MCP-shaped definition whose handler resolves a {@link CallToolResult},
 * exactly like the Claude Agent SDK's `tool()`.
 */
export function tool<T extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: T,
  handler: (args: z.infer<ZodObject<T>>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations },
): SdkMcpToolDefinition<T> {
  return {
    name,
    description,
    inputSchema: z.object(inputSchema),
    handler,
    annotations: extras?.annotations,
  }
}

/** Convert a Zod-backed tool into a JSON-Schema description. */
export function sdkToolToJsonSchema(def: SdkMcpToolDefinition): {
  name: string
  description: string
  input_schema: Record<string, unknown>
} {
  const schema = zodToJsonSchema(def.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>
  delete schema.$schema
  return {
    name: def.name,
    description: def.description,
    input_schema: schema,
  }
}

export type { SdkMcpToolDefinition, CallToolResult, ToolAnnotations }
