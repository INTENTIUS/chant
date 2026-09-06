/**
 * The fountain opRuntime provider (#2126).
 *
 * Every test here drives the real provider through the two injected seams —
 * `FountainHttp` for REST, `FountainSse` for the stream — so the whole path
 * from "post the prompt" to "parse the run record" runs with no network and no
 * clock. The stream fixtures are scripted per connection, which is how the
 * idle-close case is expressed: connection one ends without a terminal event,
 * and connection two is what `Last-Event-ID` gets.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChantConfig } from "@intentius/chant/config";
import type { OpConfig, StepRecord } from "@intentius/chant/op";
import {
  createFountainOpRuntime,
  parseRunRecord,
  parseSseFrame,
  runPrompt,
  runStateOfTurn,
  tailConversation,
  turnRunsOp,
  type FountainSse,
  type FountainSseEvent,
} from "./runtime";
import type { FountainHttp } from "./activities/fountain-apply";
import { Steward, __resetStewardsForTests } from "../composites/steward";
import { Environment } from "../generated/index";

// ── fixtures ──────────────────────────────────────────────────────────────

const CONFIG: ChantConfig = {
  lexicons: ["fountain"],
  fountain: {
    profiles: {
      staging: {
        endpoint: "https://fountain.example.com",
        token: { env: "FOUNTAIN_TEST_TOKEN" },
        team: "steward",
      },
    },
    defaultProfile: "staging",
  },
} as ChantConfig;

const OP: OpConfig = {
  name: "alb-deploy",
  overview: "Deploy the load balancer",
  phases: [],
} as unknown as OpConfig;

const RECORD = {
  version: 1,
  id: "run-7",
  op: "alb-deploy",
  env: "staging",
  started: "2026-03-01T10:00:00.000Z",
  ended: "2026-03-01T10:04:00.000Z",
  status: "ok",
  labels: { Env: "staging" },
  outcomes: { Drift: false },
  phases: [{ name: "Plan", status: "ok", steps: [] }],
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Scripted REST. A route may answer once per call; the last entry repeats. */
function fakeHttp(routes: Record<string, { status: number; json?: unknown }>): {
  http: FountainHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: FountainHttp = async (method, path, body) => {
    calls.push({ method, path, body });
    const hit = routes[`${method} ${path}`];
    if (!hit) throw new Error(`unrouted: ${method} ${path}`);
    return { status: hit.status, json: hit.json ?? null };
  };
  return { http, calls };
}

/** The routes every steward lookup needs before it can do anything else. */
function stewardRoutes(extra: Record<string, { status: number; json?: unknown }> = {}) {
  return {
    "GET /api/agents?search=steward": { status: 200, json: { data: [{ id: "agent-1", name: "steward" }] } },
    "GET /api/team/agent-1/conversations": {
      status: 200,
      json: { data: [{ id: "conv-1", status: "idle", channel_id: "fountain:team" }] },
    },
    ...extra,
  };
}

function sseEvent(id: string, payload: unknown): FountainSseEvent {
  return { id, data: JSON.stringify(payload) };
}

/**
 * A stream that hands out one scripted connection per call. A connection that
 * simply ends is fountain's 60-second idle close, which the provider answers
 * by reconnecting with `Last-Event-ID`.
 */
function fakeSse(connections: FountainSseEvent[][]): {
  sse: FountainSse;
  opens: Array<{ path: string; lastEventId?: string }>;
} {
  const opens: Array<{ path: string; lastEventId?: string }> = [];
  let index = 0;
  const sse: FountainSse = (path, opts) => {
    opens.push({ path, ...(opts?.lastEventId ? { lastEventId: opts.lastEventId } : {}) });
    const events = connections[index++] ?? [];
    return {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  };
  return { sse, opens };
}

/** A monotonic fake clock — one tick per read, so durations are deterministic. */
function fakeClock(step = 1000): () => number {
  let t = Date.parse("2026-03-01T10:00:00.000Z");
  return () => {
    const value = t;
    t += step;
    return value;
  };
}

// ── pure helpers ──────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("frames an SSE block into id, event and joined data", () => {
    const event = parseSseFrame("id: 42\nevent: message\ndata: {\"a\":1}\ndata: trailing");
    expect(event).toEqual({ id: "42", event: "message", data: '{"a":1}\ntrailing' });
  });

  it("ignores a comment heartbeat, which carries no data", () => {
    expect(parseSseFrame(": keep-alive")).toBeUndefined();
  });

  it("matches a turn by the prompt the provider posts", () => {
    expect(turnRunsOp({ prompt: runPrompt("alb-deploy") }, "alb-deploy")).toBe(true);
    expect(turnRunsOp({ prompt: "chant run alb-deploy --env prod" }, "alb-deploy")).toBe(true);
    expect(turnRunsOp({ prompt: "chant run alb-deploy-canary" }, "alb-deploy")).toBe(false);
    expect(turnRunsOp({ prompt: "hello" }, "alb-deploy")).toBe(false);
  });

  it("reads the run record out of narration and a fenced block", () => {
    const text = `I ran it. Here is the record:\n\`\`\`json\n${JSON.stringify(RECORD)}\n\`\`\`\nDone.`;
    expect(parseRunRecord(text)?.id).toBe("run-7");
  });

  it("reads the last bare JSON object when nothing is fenced", () => {
    const text = `noise {"not":"a record"} then ${JSON.stringify(RECORD)}`;
    expect(parseRunRecord(text)?.op).toBe("alb-deploy");
  });

  it("returns undefined when no object is a run record", () => {
    expect(parseRunRecord("just prose, and a {} object")).toBeUndefined();
  });

  it("maps fountain's turn and conversation vocabulary onto run states", () => {
    expect(runStateOfTurn("running", "started")).toBe("running");
    expect(runStateOfTurn("idle", "done")).toBe("completed");
    expect(runStateOfTurn("idle", "failed")).toBe("failed");
    expect(runStateOfTurn("idle", "interrupted")).toBe("cancelled");
    expect(runStateOfTurn("terminated", undefined)).toBe("cancelled");
    expect(runStateOfTurn("running", undefined)).toBe("running");
  });
});

// ── start ─────────────────────────────────────────────────────────────────

describe("start", () => {
  it("posts to the steward's thread, tails the stream, and reports the record", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
      }),
    );
    const { sse, opens } = fakeSse([
      [
        sseEvent("1", { stream: "stage", stage: "provision", state: "done" }),
        sseEvent("2", { stream: "stage", stage: "setup", state: "done" }),
        sseEvent("3", { stream: "stdout", blocks: [{ kind: "tool_call", id: "t1", title: "terraform plan" }] }),
        sseEvent("4", { stream: "stdout", blocks: [{ kind: "tool_call_update", tool_call_id: "t1", status: "completed" }] }),
        sseEvent("5", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("6", { stream: "stage", stage: "turn", state: "done" }),
      ],
    ]);

    const progress: StepRecord[] = [];
    const runtime = createFountainOpRuntime({
      config: CONFIG,
      endpoint: "https://fountain.example.com",
      token: "t",
      http,
      sse,
      now: fakeClock(),
    });

    const handle = await runtime.start(OP, { progress: (r) => progress.push(r) });
    const status = await handle.result();

    expect(handle.op).toBe("alb-deploy");
    expect(status.state).toBe("completed");
    expect(status.runId).toBe("run-7");
    expect(status.endedAt).toBe("2026-03-01T10:04:00.000Z");

    // The prompt is the command line, posted on the single-writer team path.
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/team/agent-1/messages");
    expect(post?.body).toEqual({ prompt: "chant run alb-deploy" });

    // Phases reached the progress sink the way the local runtime feeds it.
    expect(progress).toHaveLength(1);
    expect(progress[0].fn).toBe("terraform plan");
    expect(progress[0].status).toBe("ok");
    expect(progress[0].phase).toBe("setup");

    expect(opens[0].path).toContain("streams=stdout,stderr,stage");
    expect(opens[0].path).toContain("blocks=true");
  });

  it("opens a fresh conversation on the Op's labels.Agent when no profile names a team", async () => {
    const configWithoutTeam = {
      lexicons: ["fountain"],
      fountain: { profiles: { staging: { endpoint: "https://f.example.com", token: { env: "T" } } }, defaultProfile: "staging" },
    } as ChantConfig;
    const { http, calls } = fakeHttp({
      "GET /api/agents?search=watchtower": { status: 200, json: { data: [{ id: "agent-9", name: "watchtower" }] } },
      "POST /api/conversations": { status: 201, json: { data: { id: "conv-9" } } },
    });
    const { sse } = fakeSse([[sseEvent("1", { stream: "stage", stage: "turn", state: "done" })]]);

    const runtime = createFountainOpRuntime({
      config: configWithoutTeam, endpoint: "https://f.example.com", token: "t", http, sse, now: fakeClock(),
    });

    const labelled = { ...OP, labels: { Agent: "watchtower" } } as OpConfig;
    const status = await (await runtime.start(labelled, {})).result();

    expect(calls.some((c) => c.path === "/api/conversations" && c.method === "POST")).toBe(true);
    expect((calls.find((c) => c.path === "/api/conversations")?.body as { agent_id: string }).agent_id).toBe("agent-9");
    // No record on the stream: the turn's own verdict is the answer.
    expect(status.state).toBe("completed");
  });

  it("prefers a --param agent binding over the Op's label", async () => {
    const configWithoutTeam = {
      lexicons: ["fountain"],
      fountain: { profiles: { staging: { endpoint: "https://f.example.com", token: { env: "T" } } }, defaultProfile: "staging" },
    } as ChantConfig;
    const { http, calls } = fakeHttp({
      "GET /api/agents?search=override": { status: 200, json: { data: [{ id: "agent-3", name: "override" }] } },
      "POST /api/conversations": { status: 201, json: { data: { id: "conv-3" } } },
    });
    const { sse } = fakeSse([[sseEvent("1", { stream: "stage", stage: "turn", state: "done" })]]);
    const runtime = createFountainOpRuntime({
      config: configWithoutTeam, endpoint: "https://f.example.com", token: "t", http, sse, now: fakeClock(),
    });

    await (await runtime.start({ ...OP, labels: { Agent: "watchtower" } } as OpConfig, {
      params: { agent: "override" },
    })).result();

    expect(calls.some((c) => c.path === "/api/agents?search=override")).toBe(true);
  });

  it("reports conversation_busy with the conversation's address and never retries", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": {
          status: 400,
          json: { error: { code: "conversation_busy" }, data: { conversation_id: "conv-1" } },
        },
      }),
    );
    const { sse } = fakeSse([[]]);
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, sse, now: fakeClock(),
    });

    await expect(runtime.start(OP, {})).rejects.toThrow(/running another op/);
    await expect(runtime.start(OP, {})).rejects.toThrow(
      /https:\/\/fountain\.example\.com\/conversations\/conv-1/,
    );
    // Two calls, one per invocation — the refusal is reported, not retried.
    expect(calls.filter((c) => c.path === "/api/team/agent-1/messages")).toHaveLength(2);
  });

  it("refuses a named profile that chant.config.ts does not declare", async () => {
    const runtime = createFountainOpRuntime({ config: CONFIG, profile: "prod", http: fakeHttp({}).http });
    await expect(runtime.start(OP, {})).rejects.toThrow(/no profile "prod" under fountain.profiles/);
  });

  it("prefers a declared Steward over the profile's team", async () => {
    __resetStewardsForTests();
    Steward({
      name: "declared-steward",
      environment: new Environment({ name: "toolchain" }),
      ops: [OP],
    });

    const { http, calls } = fakeHttp({
      "GET /api/agents?search=declared-steward": {
        status: 200,
        json: { data: [{ id: "agent-7", name: "declared-steward" }] },
      },
      "POST /api/team/agent-7/messages": { status: 202, json: { data: { conversation_id: "conv-7" } } },
    });
    const { sse } = fakeSse([[sseEvent("1", { stream: "stage", stage: "turn", state: "done" })]]);
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, sse, now: fakeClock(),
    });

    // CONFIG's profile names the team "steward"; the declaration wins.
    await (await runtime.start(OP, {})).result();
    expect(calls.some((c) => c.path === "/api/team/agent-7/messages")).toBe(true);
    expect(calls.some((c) => c.path.includes("search=steward&"))).toBe(false);
    __resetStewardsForTests();
  });

  it("refuses an Op with no steward anywhere, naming all three ways to give it one", async () => {
    const bare = { lexicons: ["fountain"] } as ChantConfig;
    const runtime = createFountainOpRuntime({
      config: bare, endpoint: "https://f.example.com", token: "t", http: fakeHttp({}).http,
    });
    await expect(runtime.start(OP, {})).rejects.toThrow(/no steward for Op "alb-deploy"/);
    await expect(runtime.start(OP, {})).rejects.toThrow(/--param agent=/);
  });
});

// ── the stream ────────────────────────────────────────────────────────────

describe("tailConversation", () => {
  it("reconnects with Last-Event-ID after an idle close and loses no events", async () => {
    const { sse, opens } = fakeSse([
      // Connection one: the tool call starts, then the server closes it idle.
      [
        sseEvent("1", { stream: "stdout", blocks: [{ kind: "tool_call", id: "t1", title: "plan" }] }),
        sseEvent("2", { stream: "stdout", blocks: [{ kind: "tool_call_update", tool_call_id: "t1", status: "completed" }] }),
      ],
      // Connection two: the server replays event 2 and carries on to the end.
      [
        sseEvent("2", { stream: "stdout", blocks: [{ kind: "tool_call_update", tool_call_id: "t1", status: "completed" }] }),
        sseEvent("3", { stream: "stdout", blocks: [{ kind: "tool_call", id: "t2", title: "apply" }] }),
        sseEvent("4", { stream: "stdout", blocks: [{ kind: "tool_call_update", tool_call_id: "t2", status: "completed" }] }),
        sseEvent("5", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("6", { stream: "stage", stage: "turn", state: "done" }),
      ],
    ]);

    const progress: StepRecord[] = [];
    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 60_000,
      now: fakeClock(),
      progress: (r) => progress.push(r),
    });

    expect(opens).toHaveLength(2);
    expect(opens[1].lastEventId).toBe("2");
    // The replayed event 2 is folded in once, not twice.
    expect(progress.map((r) => r.fn)).toEqual(["plan", "apply"]);
    expect(status.state).toBe("completed");
  });

  it("ends the wait with an error naming the conversation when nothing arrives", async () => {
    const sse: FountainSse = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    });

    await expect(
      tailConversation({
        sse,
        conversationId: "conv-1",
        op: "alb-deploy",
        startedAt: "2026-03-01T10:00:00.000Z",
        idleTimeoutMs: 5,
        now: () => Date.now(),
      }),
    ).rejects.toThrow(/nothing arrived on conversation conv-1/);
  });

  it("names FOUNTAIN_STREAM_IDLE_TIMEOUT so the wait can be widened", async () => {
    const { sse } = fakeSse([[], [], []]);
    // Every connection ends immediately and the clock runs past the deadline,
    // which is exactly the "no event at all" case, across reconnects.
    await expect(
      tailConversation({
        sse,
        conversationId: "conv-2",
        op: "alb-deploy",
        startedAt: "2026-03-01T10:00:00.000Z",
        idleTimeoutMs: 1000,
        now: fakeClock(60_000),
      }),
    ).rejects.toThrow(/FOUNTAIN_STREAM_IDLE_TIMEOUT/);
  });

  it("reports a cancelled run when the signal is already aborted", async () => {
    const { sse } = fakeSse([[]]);
    const controller = new AbortController();
    controller.abort();
    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 1000,
      now: fakeClock(),
      signal: controller.signal,
    });
    expect(status.state).toBe("cancelled");
  });
});

// ── status, log, list ─────────────────────────────────────────────────────

describe("status, log and list read the thread", () => {
  const TURNS = {
    status: 200,
    json: {
      data: [
        { id: "turn-1", prompt: "chant run alb-deploy", state: "done", started_at: "2026-03-01T09:00:00.000Z", ended_at: "2026-03-01T09:02:00.000Z" },
        { id: "turn-2", prompt: "how is it going?", state: "done" },
        { id: "turn-3", prompt: "chant run alb-deploy", state: "done", started_at: "2026-03-01T10:00:00.000Z", ended_at: "2026-03-01T10:04:00.000Z" },
      ],
    },
  };

  const eventsFor = (turn: string, body: string) => ({
    [`GET /api/conversations/conv-1/events?turn_id=${turn}&blocks=true`]: {
      status: 200,
      json: { data: [{ turn_id: turn, blocks: [{ kind: "text", body }] }] },
    },
  });

  function runtimeFor(routes: Record<string, { status: number; json?: unknown }>) {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    return {
      calls,
      runtime: createFountainOpRuntime({
        config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
      }),
    };
  }

  it("status returns the newest turn for the op, parsed back into a record", async () => {
    const { runtime } = runtimeFor({
      "GET /api/conversations/conv-1/turns": TURNS,
      ...eventsFor("turn-3", JSON.stringify(RECORD)),
    });
    const status = await runtime.status("alb-deploy");
    expect(status?.state).toBe("completed");
    expect(status?.runId).toBe("run-7");
    expect(status?.startedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("status falls back to the turn itself when no record was printed", async () => {
    const { runtime } = runtimeFor({
      "GET /api/conversations/conv-1/turns": TURNS,
      ...eventsFor("turn-3", "the agent said nothing structured"),
    });
    const status = await runtime.status("alb-deploy");
    expect(status?.state).toBe("completed");
    expect(status?.runId).toBe("turn-3");
  });

  it("status is undefined when the thread has never run the op", async () => {
    const { runtime } = runtimeFor({
      "GET /api/conversations/conv-1/turns": { status: 200, json: { data: [{ id: "t", prompt: "hi" }] } },
    });
    expect(await runtime.status("alb-deploy")).toBeUndefined();
  });

  it("log returns the op's turns newest first, each as a run record", async () => {
    const older = { ...RECORD, id: "run-6", started: "2026-03-01T09:00:00.000Z", ended: "2026-03-01T09:02:00.000Z" };
    const { runtime } = runtimeFor({
      "GET /api/conversations/conv-1/turns": TURNS,
      ...eventsFor("turn-3", JSON.stringify(RECORD)),
      ...eventsFor("turn-1", JSON.stringify(older)),
    });
    const records = await runtime.log("alb-deploy");
    expect(records.map((r) => r.id)).toEqual(["run-7", "run-6"]);
  });

  it("log honours --limit", async () => {
    const { runtime } = runtimeFor({
      "GET /api/conversations/conv-1/turns": TURNS,
      ...eventsFor("turn-3", JSON.stringify(RECORD)),
    });
    expect(await runtime.log("alb-deploy", { limit: 1 })).toHaveLength(1);
  });

  it("list joins several ops onto one round trip per steward", async () => {
    const { runtime, calls } = runtimeFor({
      "GET /api/conversations/conv-1/turns": {
        status: 200,
        json: {
          data: [
            { id: "turn-1", prompt: "chant run alb-deploy", state: "done", started_at: "2026-03-01T09:00:00.000Z" },
            { id: "turn-2", prompt: "chant run db-migrate", state: "started", started_at: "2026-03-01T10:00:00.000Z" },
          ],
        },
      },
    });

    const states = await runtime.list([
      OP,
      { ...OP, name: "db-migrate" } as OpConfig,
      { ...OP, name: "never-run" } as OpConfig,
    ]);

    expect(states.get("alb-deploy")?.state).toBe("completed");
    expect(states.get("db-migrate")?.state).toBe("running");
    expect(states.get("never-run")).toBeUndefined();
    expect(calls.filter((c) => c.path === "/api/team/agent-1/conversations")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/api/conversations/conv-1/turns")).toHaveLength(1);
  });
});

// ── cancel and resolveGate ────────────────────────────────────────────────

describe("cancel", () => {
  const routes = {
    "GET /api/conversations/conv-1/turns": {
      status: 200,
      json: { data: [{ id: "turn-1", prompt: "chant run alb-deploy", state: "started" }] },
    },
    "POST /api/conversations/conv-1/interrupt": { status: 202 },
    "POST /api/conversations/conv-1/terminate": { status: 202 },
  };

  it("interrupts by default and terminates under force", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.cancel("alb-deploy", { force: false });
    expect(calls.at(-1)?.path).toBe("/api/conversations/conv-1/interrupt");

    await runtime.cancel("alb-deploy", { force: true });
    expect(calls.at(-1)?.path).toBe("/api/conversations/conv-1/terminate");
  });

  it("says so when nothing is hosting the op", async () => {
    const { http } = fakeHttp({
      "GET /api/agents?search=steward": { status: 200, json: { data: [{ id: "agent-1", name: "steward" }] } },
      "GET /api/team/agent-1/conversations": { status: 200, json: { data: [] } },
    });
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });
    await expect(runtime.cancel("alb-deploy", { force: true })).rejects.toThrow(/no conversation is running/);
  });
});

describe("resolveGate", () => {
  const routes = {
    "GET /api/conversations/conv-1/turns": {
      status: 200,
      json: { data: [{ id: "turn-1", prompt: "chant run alb-deploy", state: "done" }] },
    },
    "POST /api/conversations/conv-1/prompts": { status: 202, json: { data: { id: "turn-2" } } },
  };

  const resolution = {
    version: 1 as const,
    op: "alb-deploy",
    gate: "release",
    resolvedBy: "alex",
    timestamp: "2026-03-01T11:00:00.000Z",
    url: "https://github.com/o/r/pull/1",
  };

  it("posts the approve prompt with the approver and the url", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt: "chant run approve alb-deploy release --approver alex --url https://github.com/o/r/pull/1",
    });
  });

  it("reports conversation_busy rather than retrying the prompt", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        ...routes,
        "POST /api/conversations/conv-1/prompts": { status: 400, json: { code: "conversation_busy" } },
      }),
    );
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await expect(runtime.resolveGate!("alb-deploy", "release", resolution)).rejects.toThrow(
      /running another op/,
    );
    expect(calls.filter((c) => c.path === "/api/conversations/conv-1/prompts")).toHaveLength(1);
  });

  it("refuses --durable-requests by naming the fountain issue that unblocks it", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, durableRequests: true, now: fakeClock(),
    });

    await expect(runtime.resolveGate!("alb-deploy", "release", resolution)).rejects.toThrow(
      /BinaryBourbon\/fountain#1635/,
    );
    expect(calls.some((c) => c.path === "/api/conversations/conv-1/prompts")).toBe(false);
  });
});

// ── the plugin wiring ─────────────────────────────────────────────────────

describe("the plugin registers the provider", () => {
  it("hangs a runtime named fountain off LexiconPlugin.opRuntime", async () => {
    const { fountainPlugin } = await import("../plugin");
    expect(fountainPlugin.opRuntime?.name).toBe("fountain");
    expect(typeof fountainPlugin.opRuntime?.start).toBe("function");
    expect(typeof fountainPlugin.opRuntime?.resolveGate).toBe("function");
  });

  it("never touches the network at construction", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    createFountainOpRuntime({});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
