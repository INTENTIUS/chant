/**
 * `chant acp` — chant as an Agent Client Protocol agent (#2125, epic #2115).
 *
 * An editor or fountain spawns this process, speaks JSON-RPC 2.0 over stdio,
 * and gets `session/update` notifications back. Every prompt is one chant
 * command line, so a fountain thread of turns reads as an environment's shell
 * history, and a run's steps arrive as tool calls a client already knows how
 * to render.
 *
 * It is fountain-agnostic by construction. Nothing here imports the fountain
 * API, a fountain type, or a fountain URL; it lives in this lexicon because
 * fountain is its first host (epic #2115's steward runs `runtime: "acp"`,
 * `runtime_command: "chant acp"`), and any ACP client can drive it unchanged.
 *
 * Three deliberate limits:
 *
 * - **Turns are serialized.** A turn borrows the process writers to stream a
 *   command's output (./output.ts) and changes into the session's `cwd`
 *   (./turn.ts). Both are process-wide, so two turns at once would interleave.
 *   One stdio connection running one command at a time is the honest shape.
 * - **`mcpServers` from `session/new` is ignored.** chant's tools are its own
 *   verbs; there is nothing here for an MCP server to extend.
 * - **The server never reads or prints the environment it inherits.** A step's
 *   output is streamed verbatim, secrets included, because redaction belongs
 *   to the thread that stores it — fountain redacts on the way in (see
 *   ../skills/chant-fountain.md).
 */

import { randomUUID } from "node:crypto";
import {
  JsonRpcError,
  JsonRpcPeer,
  type JsonRpcHandler,
  type LineTransport,
} from "./jsonrpc";
import {
  ACP_PROTOCOL_VERSION,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  type CancelParams,
  type InitializeParams,
  type InitializeResult,
  type NewSessionParams,
  type NewSessionResult,
  type PermissionOption,
  type PromptParams,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallStatus,
} from "./protocol";
import { parseChantCommandLine } from "./command-line";
import { createChantHost, ACP_APPROVER, type ChantHost } from "./host";
import { runTurn, ALLOW_OPTION, REJECT_OPTION, type PendingPermission, type TurnSink } from "./turn";

/** How `chant acp` is configured, and where a test substitutes its own project. */
export interface AcpServerOptions {
  /**
   * Behind BinaryBourbon/fountain#1635: carry a gate to the client as a
   * `session/request_permission` and end the turn `waiting`, instead of
   * replying with the approve line and ending it. Default off, because no
   * client can answer a request that outlives a turn until #1635 ships.
   */
  durableRequests?: boolean;
  /** Version reported as `agentInfo`. */
  version?: string;
  /** Builds the project-facing half of a session. Substituted by the conformance test. */
  createHost?: (cwd: string) => ChantHost;
  /** Mints permission request ids. Injected so a test can pin them. */
  newRequestId?: () => string;
}

/** One open session: a working directory, the turn in flight, and any gate awaiting an answer. */
interface Session {
  id: string;
  host: ChantHost;
  controller?: AbortController;
  permissions: Map<string, PendingPermission>;
  /**
   * A `session/request_permission` the client answered inside the turn that
   * sent it, keyed by request id. Kept so a resume prompt naming only the
   * request id still knows what the client chose.
   */
  earlyAnswers: Map<string, string>;
}

export class AcpServer implements JsonRpcHandler {
  private peer: JsonRpcPeer | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly durableRequests: boolean;
  private readonly version: string;
  private readonly createHost: (cwd: string) => ChantHost;
  private readonly newRequestId: () => string;
  /** Serializes turns — see the module doc. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AcpServerOptions = {}) {
    this.durableRequests = opts.durableRequests ?? false;
    this.version = opts.version ?? "dev";
    this.createHost = opts.createHost ?? createChantHost;
    this.newRequestId = opts.newRequestId ?? (() => randomUUID());
  }

  /** Serve one connection until it closes. */
  connect(transport: LineTransport): JsonRpcPeer {
    this.peer = new JsonRpcPeer(transport, this);
    return this.peer;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize((params ?? {}) as InitializeParams);
      case "session/new":
        return this.newSession((params ?? {}) as NewSessionParams);
      case "session/prompt":
        return this.enqueue(() => this.prompt((params ?? {}) as PromptParams));
      default:
        throw new JsonRpcError(JSONRPC_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  notify(method: string, params: unknown): void {
    if (method !== "session/cancel") return;
    const { sessionId } = (params ?? {}) as CancelParams;
    // A notification, not a request: the pending `session/prompt` is what
    // answers, with `cancelled`. Aborting the controller stops the in-flight
    // activity through the executor's own signal, which then runs the Op's
    // `onFailure` phases before the run settles.
    this.sessions.get(sessionId)?.controller?.abort();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private initialize(params: InitializeParams): InitializeResult {
    // Negotiate down: answer with the highest version both ends speak.
    const offered = params.protocolVersion ?? ACP_PROTOCOL_VERSION;
    const negotiated =
      offered <= 0 || offered > ACP_PROTOCOL_VERSION ? ACP_PROTOCOL_VERSION : offered;
    return {
      protocolVersion: negotiated,
      agentInfo: { name: "chant", title: "chant", version: this.version },
      agentCapabilities: {
        // `session/load` is not implemented: a chant session is a working
        // directory and nothing else, so there is no transcript to replay
        // that the run ledger does not already hold.
        loadSession: false,
        // A chant command line is text. Claiming otherwise would invite a
        // client to send bytes this agent would have to drop.
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      // No credentials: this agent runs as whoever spawned it, against the
      // checkout it was pointed at.
      authMethods: [],
    };
  }

  private newSession(params: NewSessionParams): NewSessionResult {
    const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : process.cwd();
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      host: this.createHost(cwd),
      permissions: new Map(),
      earlyAnswers: new Map(),
    });
    return { sessionId: id };
  }

  private async prompt(params: PromptParams): Promise<PromptResult> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `unknown session "${params.sessionId}"`);
    }

    const sink = this.sinkFor(session);
    const resume = params._meta?.chant?.permission;
    if (resume) return this.resume(session, sink, resume);

    const text = promptText(params);
    return this.runCommandLine(session, sink, text);
  }

  /**
   * Answer a `session/request_permission` this agent sent in an earlier turn.
   *
   * Allowing writes the gate resolution the way `chant approve` does — the
   * fact is chant's, not the protocol's — and re-runs the command line that
   * hit the gate, which now walks through it.
   */
  private async resume(
    session: Session,
    sink: TurnSink,
    resume: { requestId: string; optionId: string },
  ): Promise<PromptResult> {
    const pending = session.permissions.get(resume.requestId);
    if (!pending) {
      sink.message(
        `No gate is waiting on request "${resume.requestId}" in this session.\n` +
          `Prompt the command line again to re-evaluate its gates.\n`,
      );
      return { stopReason: "end_turn" };
    }

    const optionId = resume.optionId || session.earlyAnswers.get(resume.requestId) || REJECT_OPTION;
    session.permissions.delete(resume.requestId);
    session.earlyAnswers.delete(resume.requestId);

    if (optionId !== ALLOW_OPTION) {
      sink.message(
        `Gate "${pending.gate}" on Op "${pending.op}" was rejected. Nothing was run.\n`,
      );
      return { stopReason: "end_turn" };
    }

    try {
      await session.host.resolveGate(pending.op, pending.gate, ACP_APPROVER);
    } catch (err) {
      sink.message(
        `Could not record the resolution for gate "${pending.gate}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return { stopReason: "refusal" };
    }

    sink.message(`Gate "${pending.gate}" resolved by ${ACP_APPROVER}. Re-running.\n`);
    return this.runCommandLine(session, sink, pending.prompt);
  }

  private async runCommandLine(
    session: Session,
    sink: TurnSink,
    text: string,
  ): Promise<PromptResult> {
    const parsed = await parseChantCommandLine(text);
    if (!parsed.ok) {
      // Refused before anything ran — the error block is the whole turn.
      sink.message(`${parsed.message}\n\n${parsed.hint}\n`);
      return { stopReason: "refusal" };
    }

    const controller = new AbortController();
    session.controller = controller;
    try {
      const outcome = await runTurn({
        host: session.host,
        command: parsed.command,
        promptText: text,
        sink,
        signal: controller.signal,
        durableRequests: this.durableRequests,
        newRequestId: this.newRequestId,
      });
      if (outcome.permission) {
        session.permissions.set(outcome.permission.requestId, { ...outcome.permission });
      }
      return { stopReason: outcome.stopReason };
    } finally {
      session.controller = undefined;
    }
  }

  /** The client-facing half of a turn, bound to one session. */
  private sinkFor(session: Session): TurnSink {
    const update = (u: SessionUpdate): void => {
      const notification: SessionNotification = { sessionId: session.id, update: u };
      this.peer?.notify("session/update", notification);
    };

    return {
      message(text) {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      },
      toolCall(id, title, rawInput) {
        update({
          sessionUpdate: "tool_call",
          toolCallId: id,
          title,
          kind: "execute",
          status: "pending",
          rawInput,
        });
      },
      toolCallUpdate(id, status: ToolCallStatus, detail) {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          ...(detail?.text ? { content: [{ type: "text" as const, text: detail.text }] } : {}),
          ...(detail?.rawOutput ? { rawOutput: detail.rawOutput } : {}),
        });
      },
      requestPermission: async (
        requestId: string,
        title: string,
        options: PermissionOption[],
        meta: Record<string, unknown>,
      ) => {
        const params: RequestPermissionParams = {
          sessionId: session.id,
          toolCall: { toolCallId: requestId, title, kind: "execute" },
          options,
          _meta: meta,
        };
        const answer = this.peer?.request("session/request_permission", params);
        if (!answer) return;
        // Not awaited: the whole point of a durable request is that it can be
        // answered after the turn ends (BinaryBourbon/fountain#1635). A client
        // that answers within the turn has its choice remembered, so a resume
        // prompt naming only the request id can use it.
        void answer.then(
          (raw) => {
            const outcome = (raw as RequestPermissionResult | undefined)?.outcome;
            if (outcome?.outcome !== "selected") return;
            session.earlyAnswers.set(requestId, outcome.optionId);
          },
          () => undefined,
        );
      },
    };
  }
}

/** Every text block of a prompt, joined — a command line is one line of text. */
function promptText(params: PromptParams): string {
  return (params.prompt ?? [])
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
}
