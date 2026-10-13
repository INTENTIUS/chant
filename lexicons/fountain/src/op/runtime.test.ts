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
  flagsOfPrompt,
  parseRunRecord,
  quoteArg,
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

describe("quoteArg and flagsOfPrompt (#3539)", () => {
  it("leaves a plain word bare and quotes anything the tokenizer would split or unquote", async () => {
    const { tokenize } = await import("../acp/command-line");
    expect(quoteArg("alex")).toBe("alex");
    expect(quoteArg("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    for (const value of ["Alex Smith", 'say "hi"', "back\\slash", "it's", "", "a\tb"]) {
      expect(tokenize(`--approver ${quoteArg(value)}`)).toEqual(["--approver", value]);
    }
  });

  it("reads --env and every --param off a posted prompt, quotes included", () => {
    expect(flagsOfPrompt('chant run x --env prod --param a=1 --param "b=two words" --on local')).toEqual({
      env: "prod",
      params: { a: "1", b: "two words" },
    });
    expect(flagsOfPrompt("chant run x --env=prod --param=a=1")).toEqual({ env: "prod", params: { a: "1" } });
    expect(flagsOfPrompt("chant run x --on local")).toEqual({});
    // #3555: --work and --holder too.
    expect(flagsOfPrompt('chant run x --work ISSUE-7 --holder "box steward" --on local')).toEqual({
      work: { item: "ISSUE-7", holder: "box steward" },
    });
    expect(flagsOfPrompt("chant run x --work=ISSUE-7")).toEqual({ work: { item: "ISSUE-7" } });
    // An env that is quoted is read as one value, where a whitespace split read half of it.
    expect(flagsOfPrompt('chant run x --env "prod east"')).toEqual({ env: "prod east" });
    expect(flagsOfPrompt('chant run x --env "unterminated')).toEqual({});
    expect(flagsOfPrompt(undefined)).toEqual({});
  });
});

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
    // `--on local` keeps a project's `run.on: "fountain"` from posting again
    // from the sandbox (#3225).
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/team/agent-1/messages");
    expect(post?.body).toEqual({ prompt: "chant run alb-deploy --on local" });

    // Phases reached the progress sink the way the local runtime feeds it.
    expect(progress).toHaveLength(1);
    expect(progress[0].fn).toBe("terraform plan");
    expect(progress[0].status).toBe("ok");
    expect(progress[0].phase).toBe("setup");

    expect(opens[0].path).toContain("streams=stdout,stderr,stage");
    expect(opens[0].path).toContain("blocks=true");
  });

  // #3232: `--env` rides on the posted command line, so the sandbox's run
  // sees the environment the caller asked for.
  it("posts --env on the command line when the run names one (#3232)", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
      }),
    );
    const { sse } = fakeSse([
      [
        sseEvent("1", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("2", { stream: "stage", stage: "turn", state: "done" }),
      ],
    ]);
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, sse, now: fakeClock(),
    });

    const handle = await runtime.start(OP, { env: "staging" });
    await handle.result();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ prompt: "chant run alb-deploy --env staging --on local" });

    const { parseChantCommandLine } = await import("../acp/command-line");
    const parsed = await parseChantCommandLine((post?.body as { prompt: string }).prompt);
    expect(parsed.ok && parsed.command.kind === "op-run" && parsed.command.op).toBe("alb-deploy");
    expect(parsed.ok && parsed.command.args.env).toBe("staging");
    expect(parsed.ok && parsed.command.args.on).toBe("local");
  });

  it("refuses an --env the command line cannot carry, by name, before posting anything (#3232)", async () => {
    const { http, calls } = fakeHttp(stewardRoutes({}));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await expect(runtime.start(OP, { env: "prod east" })).rejects.toThrow(/--env "prod east" cannot be posted/);
    expect(calls).toEqual([]);
  });

  // #3539: `--param` rides on the posted line, quoted when a value needs it,
  // and the sandbox's parser reads each one back.
  it("posts each --param on the command line (#3539)", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
      }),
    );
    const { sse } = fakeSse([
      [
        sseEvent("1", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("2", { stream: "stage", stage: "turn", state: "done" }),
      ],
    ]);
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, sse, now: fakeClock(),
    });

    const handle = await runtime.start(OP, { env: "staging", params: { tier: "gold", note: "two words" } });
    await handle.result();

    const post = calls.find((c) => c.method === "POST");
    const prompt = (post?.body as { prompt: string }).prompt;
    expect(prompt).toBe('chant run alb-deploy --env staging --param tier=gold --param "note=two words" --on local');

    const { parseChantCommandLine } = await import("../acp/command-line");
    const parsed = await parseChantCommandLine(prompt);
    expect(parsed.ok && parsed.command.kind === "op-run" && parsed.command.op).toBe("alb-deploy");
    expect(parsed.ok && parsed.command.args.param).toEqual(["tier=gold", "note=two words"]);
    expect(parsed.ok && parsed.command.args.on).toBe("local");
  });

  // #3555: `--work` and `--holder` ride on the posted line, so an Op whose
  // work lease leaves the item to the run can run on fountain; the sandbox's
  // parser reads both back.
  it("posts --work and --holder on the command line (#3555)", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
      }),
    );
    const { sse } = fakeSse([
      [
        sseEvent("1", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("2", { stream: "stage", stage: "turn", state: "done" }),
      ],
    ]);
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, sse, now: fakeClock(),
    });
    expect(runtime.carriesWork).toBe(true);

    const handle = await runtime.start(OP, { env: "staging", work: { item: "ISSUE-7", holder: "box steward" } });
    await handle.result();

    const post = calls.find((c) => c.method === "POST");
    const prompt = (post?.body as { prompt: string }).prompt;
    expect(prompt).toBe('chant run alb-deploy --env staging --work ISSUE-7 --holder "box steward" --on local');

    const { parseChantCommandLine } = await import("../acp/command-line");
    const parsed = await parseChantCommandLine(prompt);
    expect(parsed.ok && parsed.command.kind === "op-run" && parsed.command.op).toBe("alb-deploy");
    expect(parsed.ok && parsed.command.args.work).toBe("ISSUE-7");
    expect(parsed.ok && parsed.command.args.holder).toBe("box steward");
    expect(parsed.ok && parsed.command.args.on).toBe("local");
  });

  it("refuses a --work the sandbox would read as missing, by name, before posting anything (#3555)", async () => {
    const { http, calls } = fakeHttp(stewardRoutes({}));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await expect(runtime.start(OP, { work: { item: "-7" } })).rejects.toThrow(/--work "-7" cannot be posted/);
    await expect(runtime.start(OP, { work: { holder: "" } })).rejects.toThrow(/--holder "" cannot be posted/);
    expect(calls).toEqual([]);
  });

  // #3524: a teammate's thread already holds finished turns, and the stream's
  // first connection replays the whole log. The old turn's `done` and record
  // must not settle (or describe) the run the post just queued.
  it("does not settle on an earlier turn's done replayed from the teammate's stream (#3524)", async () => {
    const OLD_RECORD = { ...RECORD, id: "run-old" };
    const { http } = fakeHttp(
      stewardRoutes({
        "GET /api/conversations/conv-1/turns": {
          status: 200,
          json: { data: [{ id: "turn-old", prompt: runPrompt("alb-deploy"), state: "done" }] },
        },
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
      }),
    );
    const { sse } = fakeSse([
      [
        // Replayed: the earlier turn, start to finish.
        sseEvent("1", { turn_id: "turn-old", stream: "stage", stage: "turn", state: "started" }),
        sseEvent("2", { turn_id: "turn-old", stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(OLD_RECORD) }] }),
        sseEvent("3", { turn_id: "turn-old", stream: "stage", stage: "turn", state: "done" }),
        // The new turn.
        sseEvent("4", { turn_id: "turn-new", stream: "stage", stage: "turn", state: "started" }),
        sseEvent("5", { turn_id: "turn-new", stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
        sseEvent("6", { turn_id: "turn-new", stream: "stage", stage: "turn", state: "failed" }),
      ],
    ]);

    const runtime = createFountainOpRuntime({
      config: CONFIG,
      endpoint: "https://fountain.example.com",
      token: "t",
      http,
      sse,
      now: fakeClock(),
    });

    const status = await (await runtime.start(OP, {})).result();

    // Settled on turn-new's own record, not turn-old's.
    expect(status.runId).toBe("run-7");
    expect(status.runId).not.toBe("run-old");
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

  // #2192 — `chant run <op> --on fountain --profile prod` reaches here as
  // `OpRunStartOptions.profile`, and picks that profile's endpoint, token and
  // team instead of `defaultProfile`'s.
  it("--profile on the run selects that profile's endpoint, token and team", async () => {
    vi.stubEnv("FOUNTAIN_PROD_TOKEN", "prod-token");
    const config = {
      lexicons: ["fountain"],
      fountain: {
        profiles: {
          staging: { endpoint: "https://staging.example.com", token: { env: "FOUNTAIN_TEST_TOKEN" }, team: "staging-steward" },
          prod: { endpoint: "https://prod.example.com", token: { env: "FOUNTAIN_PROD_TOKEN" }, team: "prod-steward" },
        },
        defaultProfile: "staging",
      },
    } as ChantConfig;

    const { http, calls } = fakeHttp({
      "GET /api/agents?search=prod-steward": {
        status: 200,
        json: { data: [{ id: "agent-9", name: "prod-steward" }] },
      },
      "POST /api/team/agent-9/messages": { status: 202, json: { data: { conversation_id: "conv-9" } } },
    });
    const { sse } = fakeSse([[sseEvent("1", { stream: "stage", stage: "turn", state: "done" })]]);
    const runtime = createFountainOpRuntime({ config, http, sse, now: fakeClock() });

    const handle = await runtime.start(OP, { profile: "prod" });
    await handle.result();

    // The prod profile's team, not the default profile's.
    expect(calls.some((c) => c.path === "/api/team/agent-9/messages")).toBe(true);
    expect(calls.some((c) => c.path.includes("staging-steward"))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("--profile naming an undeclared entry is refused on the run, not silently defaulted", async () => {
    const runtime = createFountainOpRuntime({ config: CONFIG, http: fakeHttp({}).http });
    await expect(runtime.start(OP, { profile: "prod" })).rejects.toThrow(
      /no profile "prod" under fountain.profiles/,
    );
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

  it("fails the run on fountain's own reason when the conversation dies during provision (#2167)", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        "POST /api/team/agent-1/messages": { status: 202, json: { data: { conversation_id: "conv-1" } } },
        "GET /api/conversations/conv-1": {
          status: 200,
          json: {
            data: {
              id: "conv-1",
              status: "failed",
              turn_count: 0,
              sandbox: { status: "failed" },
            },
          },
        },
      }),
    );
    // The stream opens, carries nothing and closes: no `stage: turn` event is
    // ever emitted for a conversation that never started a turn.
    const { sse, opens } = fakeSse([[]]);

    const runtime = createFountainOpRuntime({
      config: CONFIG,
      endpoint: "https://fountain.example.com",
      token: "t",
      http,
      sse,
      // The default 1800s; the run must not wait any part of it.
      now: () => Date.now(),
    });

    const status = await (await runtime.start(OP, {})).result();

    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/fountain ended conversation conv-1 as "failed"/);
    expect(opens).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/api/conversations/conv-1")).toHaveLength(1);
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

  it("ignores a replayed earlier turn and settles only on the new turn's terminal event (#3524)", async () => {
    const { sse } = fakeSse([
      [
        sseEvent("1", { turn_id: "turn-old", stream: "stage", stage: "turn", state: "done" }),
        sseEvent("2", { turn_id: "turn-new", stream: "stage", stage: "turn", state: "started" }),
        sseEvent("3", { turn_id: "turn-new", stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] }),
      ],
      // The new turn is still running when the first connection closes; the
      // reconnect resumes after event 3 and carries the terminal event.
      [sseEvent("4", { turn_id: "turn-new", stream: "stage", stage: "turn", state: "done" })],
    ]);

    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 60_000,
      now: fakeClock(),
      ignoreTurns: new Set(["turn-old"]),
    });

    // Settling on event 1 would have used one connection; the new turn's own
    // `done` is on the second.
    expect(status.state).toBe("completed");
    expect(status.runId).toBe("run-7");
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

  // ── a conversation fountain has already failed (#2167) ──────────────────

  /** `GET /api/conversations/:id` for a sandbox that never provisioned. */
  const FAILED_CONVERSATION = {
    status: 200,
    json: {
      data: {
        id: "conv-1",
        status: "failed",
        turn_count: 0,
        acp: true,
        sandbox: { status: "failed" },
        inserted_at: "2026-03-01T10:00:00.000Z",
        updated_at: "2026-03-01T10:00:01.000Z",
      },
    },
  };

  /** A stream that stays open and says nothing — the live failure's shape. */
  const silentSse: FountainSse = () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  });

  it("settles on the conversation when the stream is quiet and fountain has failed it", async () => {
    const { http, calls } = fakeHttp({ "GET /api/conversations/conv-1": FAILED_CONVERSATION });

    const status = await tailConversation({
      sse: silentSse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      // Half an hour of patience, which is the default — and irrelevant, because
      // the conversation is already dead.
      idleTimeoutMs: 1_800_000,
      pollIntervalMs: 1,
      http,
      now: () => Date.now(),
    });

    expect(status.state).toBe("failed");
    expect(status.runId).toBe("conv-1");
    expect(status.error).toMatch(/"failed"/);
    expect(status.error).toMatch(/sandbox "failed"/);
    expect(status.error).toMatch(/before the turn started/);
    expect(calls).toEqual([{ method: "GET", path: "/api/conversations/conv-1", body: undefined }]);
  });

  it("polls when the connection ends, and does not reconnect into a dead conversation", async () => {
    const { sse, opens } = fakeSse([[], [], []]);
    const { http } = fakeHttp({ "GET /api/conversations/conv-1": FAILED_CONVERSATION });

    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 1_800_000,
      http,
      now: () => Date.now(),
    });

    expect(status.state).toBe("failed");
    expect(opens).toHaveLength(1);
  });

  it("reports a terminated conversation as cancelled, not failed", async () => {
    const { http } = fakeHttp({
      "GET /api/conversations/conv-1": {
        status: 200,
        json: { data: { id: "conv-1", status: "terminated", turn_count: 0 } },
      },
    });
    const { sse } = fakeSse([[]]);

    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 1_800_000,
      http,
      now: () => Date.now(),
    });

    expect(status.state).toBe("cancelled");
    expect(status.error).toBeUndefined();
  });

  it("keeps waiting through a poll that finds the conversation alive, and loses no event", async () => {
    const { http, calls } = fakeHttp({
      "GET /api/conversations/conv-1": {
        status: 200,
        json: { data: { id: "conv-1", status: "running", turn_count: 1 } },
      },
    });
    // The turn thinks until the poller has had more than one look at it, then
    // finishes: several polls, then the event the polls were waiting through.
    //
    // The wait is on the poll count rather than on a fixed sleep. This used to
    // sleep 25ms and assert that more than one 1ms poll had fit inside it,
    // which is a wall-clock race the full suite loses every so often: a worker
    // stalled past the sleep leaves the first event already due, exactly one
    // poll lands, and `calls.length` is 1. Waiting on the number the assertion
    // is about makes the same claim without timing it. The deadline keeps a
    // genuine regression — a tail that stops polling — a loud failure here
    // instead of a hang.
    const deadline = Date.now() + 5_000;
    const sse: FountainSse = () => ({
      async *[Symbol.asyncIterator]() {
        while (calls.length < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        yield sseEvent("1", { stream: "stdout", blocks: [{ kind: "text", body: JSON.stringify(RECORD) }] });
        yield sseEvent("2", { stream: "stage", stage: "turn", state: "done" });
      },
    });

    const status = await tailConversation({
      sse,
      conversationId: "conv-1",
      op: "alb-deploy",
      startedAt: "2026-03-01T10:00:00.000Z",
      idleTimeoutMs: 1_800_000,
      pollIntervalMs: 1,
      http,
      now: () => Date.now(),
    });

    expect(status.state).toBe("completed");
    expect(status.runId).toBe("run-7");
    expect(calls.length).toBeGreaterThan(1);
  });

  it("still waits out the idle timeout when no REST seam is given", async () => {
    await expect(
      tailConversation({
        sse: silentSse,
        conversationId: "conv-1",
        op: "alb-deploy",
        startedAt: "2026-03-01T10:00:00.000Z",
        idleTimeoutMs: 5,
        now: () => Date.now(),
      }),
    ).rejects.toThrow(/nothing arrived on conversation conv-1/);
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

  it("status reports a conversation fountain failed before any turn started (#2167)", async () => {
    const { http } = fakeHttp({
      "GET /api/agents?search=steward": { status: 200, json: { data: [{ id: "agent-1", name: "steward" }] } },
      "GET /api/team/agent-1/conversations": {
        status: 200,
        json: {
          data: [
            {
              id: "conv-1",
              status: "failed",
              channel_id: "fountain:team",
              turn_count: 0,
              sandbox: { status: "failed" },
              inserted_at: "2026-03-01T10:00:00.000Z",
              updated_at: "2026-03-01T10:00:01.000Z",
            },
          ],
        },
      },
      "GET /api/conversations/conv-1/turns": { status: 200, json: { data: [] } },
    });
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    const status = await runtime.status("alb-deploy");
    expect(status?.state).toBe("failed");
    expect(status?.runId).toBe("conv-1");
    expect(status?.startedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(status?.endedAt).toBe("2026-03-01T10:00:01.000Z");
    expect(status?.error).toMatch(/sandbox "failed"/);
  });

  it("status still says nothing for a failed conversation that ran other turns", async () => {
    const { http } = fakeHttp({
      "GET /api/agents?search=steward": { status: 200, json: { data: [{ id: "agent-1", name: "steward" }] } },
      "GET /api/team/agent-1/conversations": {
        status: 200,
        json: { data: [{ id: "conv-1", status: "failed", channel_id: "fountain:team", turn_count: 1 }] },
      },
      "GET /api/conversations/conv-1/turns": {
        status: 200,
        json: { data: [{ id: "turn-1", prompt: "chant run db-migrate", state: "done" }] },
      },
    });
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });
    // The thread failed, but it ran somebody else's op. Reporting this op as
    // failed would invent a run it never had.
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

  // #2192 — the prompt is the op's own re-run, not the approve verb again.
  // `chant run approve <op> <gate>` parsed as a verb in the sandbox and wrote
  // the same resolution a second time on the local runtime; only `chant run
  // <op>` re-applies and walks through the now-resolved gate.
  it("posts the op's re-run prompt with the approver and the url", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt: "chant run alb-deploy --on local --approver alex --url https://github.com/o/r/pull/1",
    });
  });

  // #3232: the re-run runs in the environment the gated run did.
  it("carries the gated turn's --env onto the re-run prompt", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        ...routes,
        "GET /api/conversations/conv-1/turns": {
          status: 200,
          json: {
            data: [
              { id: "turn-1", prompt: "chant run alb-deploy --on local", state: "done" },
              { id: "turn-2", prompt: "chant run alb-deploy --env prod --on local", state: "done" },
            ],
          },
        },
      }),
    );
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt: "chant run alb-deploy --env prod --on local --approver alex --url https://github.com/o/r/pull/1",
    });
  });

  // The posted string has to parse as an op run in the sandbox, or the
  // re-application never happens. This is the ACP parser core's own
  // `parseArgs`/`resolveCommand` back it, on the exact prompt above.
  it("the posted prompt parses as an op run, not as a verb", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);
    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");

    const { parseChantCommandLine } = await import("../acp/command-line");
    const parsed = await parseChantCommandLine((post?.body as { prompt: string }).prompt);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.command.kind).toBe("op-run");
    expect(parsed.ok && parsed.command.kind === "op-run" && parsed.command.op).toBe("alb-deploy");
    expect(parsed.ok && parsed.command.args.approver).toBe("alex");
    expect(parsed.ok && parsed.command.args.url).toBe("https://github.com/o/r/pull/1");
    expect(parsed.ok && parsed.command.args.on).toBe("local");
  });

  // #3539: an approver name with a space is one value on the re-run prompt.
  it("quotes an approver name with a space, and the sandbox reads it back whole (#3539)", async () => {
    const { http, calls } = fakeHttp(stewardRoutes(routes));
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", { ...resolution, resolvedBy: 'Alex "AJ" Smith' });

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    const prompt = (post?.body as { prompt: string }).prompt;
    expect(prompt).toBe(
      'chant run alb-deploy --on local --approver "Alex \\"AJ\\" Smith" --url https://github.com/o/r/pull/1',
    );

    const { parseChantCommandLine } = await import("../acp/command-line");
    const parsed = await parseChantCommandLine(prompt);
    expect(parsed.ok && parsed.command.kind === "op-run" && parsed.command.op).toBe("alb-deploy");
    expect(parsed.ok && parsed.command.args.approver).toBe('Alex "AJ" Smith');
    expect(parsed.ok && parsed.command.args.url).toBe("https://github.com/o/r/pull/1");
  });

  // #3539: `chant run approve ... --env <env> --on fountain` names the env the
  // re-run runs in, over the gated turn's.
  it("runs the re-run in the env core hands it, over the gated turn's", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        ...routes,
        "GET /api/conversations/conv-1/turns": {
          status: 200,
          json: { data: [{ id: "turn-1", prompt: "chant run alb-deploy --env prod --on local", state: "done" }] },
        },
      }),
    );
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution, { env: "staging" });

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt: "chant run alb-deploy --env staging --on local --approver alex --url https://github.com/o/r/pull/1",
    });
  });

  // #3539: the gated turn's `--param`s ride on the re-run, quoted as posted.
  it("carries the gated turn's --param flags onto the re-run prompt", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        ...routes,
        "GET /api/conversations/conv-1/turns": {
          status: 200,
          json: {
            data: [
              {
                id: "turn-1",
                prompt: 'chant run alb-deploy --env prod --param tier=gold --param "note=two words" --on local',
                state: "done",
              },
            ],
          },
        },
      }),
    );
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt:
        'chant run alb-deploy --env prod --param tier=gold --param "note=two words" --on local ' +
        "--approver alex --url https://github.com/o/r/pull/1",
    });
  });

  // #3555: the gated turn's work item and holder ride on the re-run, so the
  // re-run of an Op that needs a work item is told it again.
  it("carries the gated turn's --work and --holder onto the re-run prompt", async () => {
    const { http, calls } = fakeHttp(
      stewardRoutes({
        ...routes,
        "GET /api/conversations/conv-1/turns": {
          status: 200,
          json: {
            data: [{ id: "turn-1", prompt: 'chant run alb-deploy --work ISSUE-7 --holder "box steward" --on local', state: "done" }],
          },
        },
      }),
    );
    const runtime = createFountainOpRuntime({
      config: CONFIG, endpoint: "https://fountain.example.com", token: "t", http, now: fakeClock(),
    });

    await runtime.resolveGate!("alb-deploy", "release", resolution);

    const post = calls.find((c) => c.path === "/api/conversations/conv-1/prompts");
    expect(post?.body).toEqual({
      prompt:
        'chant run alb-deploy --work ISSUE-7 --holder "box steward" --on local ' +
        "--approver alex --url https://github.com/o/r/pull/1",
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
