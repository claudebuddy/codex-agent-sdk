/**
 * JSON-RPC 2.0 envelope types plus the Codex app-server wire messages.
 */

export type RequestId = string | number

export interface JsonRpcRequest<P = unknown> {
  jsonrpc?: '2.0'
  id: RequestId
  method: string
  params?: P
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc?: '2.0'
  method: string
  params?: P
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc?: '2.0'
  id: RequestId
  result: R
}

export interface JsonRpcErrorResponse {
  jsonrpc?: '2.0'
  id: RequestId | null
  error: JsonRpcErrorObject
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse

/** Any single line parsed off the app-server wire. */
export type JsonRpcMessage<R = unknown> =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse<R>

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  )
}

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'id' in msg &&
    'method' in msg
  )
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    !('id' in msg) &&
    'method' in msg
  )
}

export function isErrorResponse(
  msg: JsonRpcResponse,
): msg is JsonRpcErrorResponse {
  return 'error' in msg && msg.error != null
}

/** JSON-RPC standard error codes. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const
