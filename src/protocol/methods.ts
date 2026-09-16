/**
 * Codex app-server JSON-RPC method names.
 *
 * Derived from `codex-rs/app-server-protocol` (`ClientRequest`, `ServerRequest`,
 * `ClientNotification`, `ServerNotification`) and the exported JSON schema at
 * `codex-rs/app-server-protocol/schema/json`.
 *
 * The app-server speaks newline-delimited JSON-RPC 2.0 over stdio (or a Unix
 * socket / WebSocket). Every message is one JSON object on one line.
 */

/** Requests the client sends to the server. */
export const ClientMethods = {
  // --- Session bootstrap ---------------------------------------------------
  initialize: 'initialize',

  // --- Threads -------------------------------------------------------------
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadArchive: 'thread/archive',
  threadDelete: 'thread/delete',
  threadUnarchive: 'thread/unarchive',
  threadUnsubscribe: 'thread/unsubscribe',
  threadNameSet: 'thread/name/set',
  threadMetadataUpdate: 'thread/metadata/update',
  threadCompactStart: 'thread/compact/start',
  threadShellCommand: 'thread/shellCommand',
  threadRevert: 'thread/revert',
  threadList: 'thread/list',
  threadLoadedList: 'thread/loaded/list',
  threadRead: 'thread/read',
  threadTurnsList: 'thread/turns/list',
  threadItemsList: 'thread/items/list',
  threadInjectItems: 'thread/inject_items',
  threadGoalSet: 'thread/goal/set',
  threadGoalGet: 'thread/goal/get',
  threadGoalClear: 'thread/goal/clear',

  // --- Turns ---------------------------------------------------------------
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  reviewStart: 'review/start',

  // --- Models / config -----------------------------------------------------
  modelList: 'model/list',
  configRead: 'config/read',
  configValueWrite: 'config/value/write',
  configBatchWrite: 'config/batchWrite',
  configRequirementsRead: 'configRequirements/read',
  experimentalFeatureList: 'experimentalFeature/list',
  experimentalFeatureEnablementSet: 'experimentalFeature/enablement/set',

  // --- MCP -----------------------------------------------------------------
  mcpServerStatusList: 'mcpServerStatus/list',
  mcpServerResourceRead: 'mcpServer/resource/read',
  mcpServerToolCall: 'mcpServer/tool/call',
  mcpServerOauthLogin: 'mcpServer/oauth/login',
  configMcpServerReload: 'config/mcpServer/reload',

  // --- Skills / plugins ----------------------------------------------------
  skillsList: 'skills/list',
  pluginList: 'plugin/list',
  hooksList: 'hooks/list',

  // --- Account -------------------------------------------------------------
  accountRead: 'account/read',
  accountLoginStart: 'account/login/start',
  accountLoginCancel: 'account/login/cancel',
  accountLogout: 'account/logout',
  accountRateLimitsRead: 'account/rateLimits/read',

  // --- Filesystem ----------------------------------------------------------
  fsReadFile: 'fs/readFile',
  fsWriteFile: 'fs/writeFile',
  fsReadDirectory: 'fs/readDirectory',
  fsGetMetadata: 'fs/getMetadata',
  fsCreateDirectory: 'fs/createDirectory',
  fsRemove: 'fs/remove',
  fsCopy: 'fs/copy',

  // --- Commands ------------------------------------------------------------
  commandExec: 'command/exec',
  commandExecWrite: 'command/exec/write',
  commandExecTerminate: 'command/exec/terminate',
  commandExecResize: 'command/exec/resize',

  // --- Misc ----------------------------------------------------------------
  fuzzyFileSearch: 'fuzzyFileSearch',
  feedbackUpload: 'feedback/upload',
} as const

/** Requests the server sends back to the client (bidirectional RPC). */
export const ServerRequestMethods = {
  commandExecutionApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  toolUserInput: 'item/tool/requestUserInput',
  dynamicToolCall: 'item/tool/call',
  mcpElicitation: 'mcpServer/elicitation/request',
  chatgptAuthTokensRefresh: 'account/chatgptAuthTokens/refresh',
  attestationGenerate: 'attestation/generate',
  applyPatchApproval: 'applyPatchApproval',
  execCommandApproval: 'execCommandApproval',
} as const

/** Notifications the server pushes to the client. */
export const ServerNotificationMethods = {
  error: 'error',
  warning: 'warning',

  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadArchived: 'thread/archived',
  threadDeleted: 'thread/deleted',
  threadClosed: 'thread/closed',
  threadNameUpdated: 'thread/name/updated',
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',
  threadSettingsUpdated: 'thread/settings/updated',
  threadCompacted: 'thread/compacted',

  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnDiffUpdated: 'turn/diff/updated',
  turnPlanUpdated: 'turn/plan/updated',

  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeOutputDelta: 'item/fileChange/outputDelta',
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  mcpToolCallProgress: 'item/mcpToolCall/progress',

  serverRequestResolved: 'serverRequest/resolved',
  mcpServerStartupStatusUpdated: 'mcpServer/startupStatus/updated',
  skillsChanged: 'skills/changed',
  accountUpdated: 'account/updated',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  fsChanged: 'fs/changed',
  deprecationNotice: 'deprecationNotice',
  configWarning: 'configWarning',
} as const

export type ClientMethod =
  (typeof ClientMethods)[keyof typeof ClientMethods]
export type ServerRequestMethod =
  (typeof ServerRequestMethods)[keyof typeof ServerRequestMethods]
export type ServerNotificationMethod =
  (typeof ServerNotificationMethods)[keyof typeof ServerNotificationMethods]
