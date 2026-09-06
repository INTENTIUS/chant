/**
 * The Agent Client Protocol wire shapes `chant acp` speaks (#2125).
 *
 * ACP (<https://agentclientprotocol.com>) is JSON-RPC 2.0 between a *client*
 * — an editor, or fountain — and an *agent*. chant is the agent half here: it
 * is spawned, it answers `initialize`, it opens sessions, and every prompt it
 * receives is one chant command line.
 *
 * These are hand-written rather than pulled from a package on purpose. The
 * subset an agent has to speak is small enough to state in one file, and a
 * dependency for it would be a dependency in every project that declares the
 * fountain lexicon. Field names match what fountain's own ACP client sends
 * and expects (fountain ADR 0014, `cli/internal/acp`), which is the same
 * vocabulary the specification defines — a client of ours that is not
 * fountain sees nothing fountain-specific.
 */

/** The ACP major version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 error codes, plus the one ACP adds. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * How a turn ended.
 *
 * `end_turn`, `cancelled` and `refusal` are the specification's.
 *
 * `waiting` is not: it is what `--durable-requests` returns for a run that
 * stopped at a gate whose `session/request_permission` will be answered after
 * this turn is over (BinaryBourbon/fountain#1635). Until that ships, no client
 * can answer such a request within the turn, and reporting `end_turn` for a
 * run that has not finished would be a lie a client renders as success. The
 * flag is off by default for exactly this reason — see ../acp/server.ts.
 */
export type StopReason = "end_turn" | "cancelled" | "refusal" | "waiting";

/** A tool call's lifecycle, as a client renders it. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** One text block in a prompt or an update. */
export interface TextContent {
  type: "text";
  text: string;
}

/** `initialize` params. */
export interface InitializeParams {
  protocolVersion?: number;
  clientCapabilities?: unknown;
}

/** `initialize` result. */
export interface InitializeResult {
  protocolVersion: number;
  agentInfo: { name: string; title: string; version: string };
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  };
  authMethods: unknown[];
}

/** `session/new` params. `mcpServers` is accepted and ignored — see the server's module doc. */
export interface NewSessionParams {
  cwd?: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
}

/** `session/new` result. */
export interface NewSessionResult {
  sessionId: string;
}

/**
 * The out-of-band bag a client attaches to `session/prompt` to resume a
 * durable permission request (#2125). ACP's `_meta` is the extension point
 * fountain already uses for its own `channelId`, so a resume needs no method
 * of its own and a client that does not do durable requests never sends it.
 */
export interface ChantPromptMeta {
  /** Answers a `session/request_permission` this agent sent in an earlier turn. */
  permission?: { requestId: string; optionId: string };
}

/** `session/prompt` params. */
export interface PromptParams {
  sessionId: string;
  prompt: Array<TextContent | { type: string; [k: string]: unknown }>;
  _meta?: { chant?: ChantPromptMeta; [k: string]: unknown };
}

/** `session/prompt` result. */
export interface PromptResult {
  stopReason: StopReason;
}

/** `session/cancel` params. A notification: the pending prompt is what answers. */
export interface CancelParams {
  sessionId: string;
}

/** The `session/update` variants this agent emits. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: TextContent }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: "execute";
      status: ToolCallStatus;
      rawInput?: Record<string, unknown>;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: ToolCallStatus;
      content?: TextContent[];
      rawOutput?: Record<string, unknown>;
    };

/** `session/update` notification params. */
export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

/** One choice offered on a `session/request_permission`. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** `session/request_permission` params. */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind: "execute" };
  options: PermissionOption[];
  _meta?: Record<string, unknown>;
}

/** `session/request_permission` result. */
export interface RequestPermissionResult {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}
