/**
 * Newline-delimited JSON-RPC 2.0, both directions (#2125).
 *
 * ACP frames one JSON value per line. That is the whole transport, which is
 * why this is ~150 lines of local code instead of a dependency: an agent that
 * speaks the protocol needs a line reader, a writer that serializes its two
 * writers, and a table of outbound requests waiting on answers.
 *
 * The peer is stream-agnostic on purpose. `chant acp` hands it the process's
 * stdin and stdout; the conformance test hands it a pair of in-memory pipes
 * and drives the client side in the same process, so the test exercises the
 * real framing rather than a mock of it.
 */

import type { Readable, Writable } from "node:stream";

/** The four JSON-RPC message kinds, told apart by which fields are present. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** An error a handler wants reported with a specific JSON-RPC code. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** What the peer dispatches incoming traffic to. */
export interface JsonRpcHandler {
  /** Answer a request. The returned value is encoded as `result`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Handle a notification. JSON-RPC forbids a reply, so a rejection is dropped. */
  notify(method: string, params: unknown): void;
}

/** A line-delimited byte channel, so the peer never names a stream type. */
export interface LineTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * A transport over a pair of Node streams — stdin and stdout, for `chant acp`.
 *
 * The writer is bound here, at construction, and that is load-bearing rather
 * than tidy. A turn replaces `process.stdout.write` to stream a command's
 * output (../acp/output.ts); if this looked the method up per call it would
 * find the interceptor, every protocol line the turn emits would come back as
 * another message chunk to emit, and the first notification sent inside a turn
 * would recurse until V8 refused to grow the string. Binding once means the
 * protocol always reaches the real stdout.
 */
export function streamTransport(input: Readable, output: Writable): LineTransport {
  const write = output.write.bind(output);
  let buffer = "";
  let lineCb: ((line: string) => void) | undefined;
  let closeCb: (() => void) | undefined;

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) lineCb?.(line);
      nl = buffer.indexOf("\n");
    }
  });
  input.on("end", () => closeCb?.());
  input.on("close", () => closeCb?.());

  return {
    send(line) {
      write(line + "\n");
    },
    onLine(cb) {
      lineCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    close() {
      input.destroy();
    },
  };
}

/** An in-memory transport pair — one end for each side of a connection. */
export function memoryTransportPair(): [LineTransport, LineTransport] {
  const cbs: Array<((line: string) => void) | undefined> = [undefined, undefined];
  const closes: Array<(() => void) | undefined> = [undefined, undefined];
  let closed = false;

  const end = (self: 0 | 1): LineTransport => ({
    send(line) {
      if (closed) return;
      // Deliver asynchronously so a `send` inside a handler never re-enters
      // that handler through the peer's own dispatch — the same ordering a
      // real pipe gives, without the pipe.
      queueMicrotask(() => cbs[self === 0 ? 1 : 0]?.(line));
    },
    onLine(cb) {
      cbs[self] = cb;
    },
    onClose(cb) {
      closes[self] = cb;
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        closes[0]?.();
        closes[1]?.();
      });
    },
  });

  return [end(0), end(1)];
}

/**
 * One connection, serving a handler and able to originate requests of its own.
 *
 * The agent has two writers — request responses, and the `session/update`
 * notifications a turn emits while a response is still pending. `send` is the
 * single funnel for both, so two interleaved writes can never produce one
 * unparseable line.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private closed = false;

  constructor(
    private readonly transport: LineTransport,
    private readonly handler: JsonRpcHandler,
  ) {
    transport.onLine((line) => void this.receive(line));
    transport.onClose(() => this.shutdown());
  }

  /** Send a notification. Fire and forget, by definition. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Send a request and resolve with its `result`, or reject with its `error`. */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Stop serving and fail every outbound request still waiting. */
  close(): void {
    this.transport.close();
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("the connection closed before the request was answered"));
    }
    this.pending.clear();
  }

  private write(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify(message));
  }

  private async receive(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "the line was not JSON" },
      });
      return;
    }

    // A response to something we asked.
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const waiter = this.pending.get(Number(message.id));
      if (!waiter) return;
      this.pending.delete(Number(message.id));
      if (message.error) waiter.reject(new JsonRpcError(message.error.code, message.error.message));
      else waiter.resolve(message.result);
      return;
    }

    if (!message.method) return;

    // A notification: no id, no reply.
    if (message.id === undefined || message.id === null) {
      try {
        this.handler.notify(message.method, message.params);
      } catch {
        // JSON-RPC has nowhere to put this, and a stdio agent's stdout is
        // protocol only.
      }
      return;
    }

    const id = message.id;
    try {
      const result = await this.handler.request(message.method, message.params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const code = err instanceof JsonRpcError ? err.code : -32603;
      const msg = err instanceof Error ? err.message : String(err);
      this.write({ jsonrpc: "2.0", id, error: { code, message: msg } });
    }
  }
}
