import { describe, test, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsReadError, type AwsReadHttp } from "../api/read-client";
import { AgentCoreTraceError, renderValue } from "./trace-render";
import {
  AgentCoreTraceUnavailableError,
  awsAgentCoreFetchTrace,
  coerceFields,
  decimalText,
  identifierFor,
  listMemoryEvents,
  normalizeMemoryEvents,
  toEpochMs,
  type MemoryEvent,
} from "./trace-fetch";

/** A transport that answers every POST with the next canned body, recording calls. */
function mockHttp(responses: Array<{ status?: number; body: unknown }>): {
  http: AwsReadHttp;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let index = 0;
  const http: AwsReadHttp = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = responses[Math.min(index++, responses.length - 1)];
    return { status: next?.status ?? 200, text: JSON.stringify(next?.body ?? {}) };
  };
  return { http, calls };
}

const BASE = {
  memoryId: "mem-1",
  actorId: "alice",
  sessionId: "sess-1",
  endpoint: "http://localhost:4566",
};

function memoryEvent(over: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    eventId: "evt-1",
    sessionId: "sess-1",
    actorId: "alice",
    memoryId: "mem-1",
    eventTimestamp: 1_700_000_000,
    payload: [{ blob: { action: "Transfer", kind: "request", input: { amount: 10 } } }],
    ...over,
  };
}

describe("toEpochMs — restJson1 timestamps", () => {
  test("epoch seconds, fractional included", () => {
    expect(toEpochMs(1_700_000_000, "t")).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000.512, "t")).toBe(1_700_000_000_512);
  });

  test("a value already in milliseconds is left alone", () => {
    expect(toEpochMs(1_700_000_000_000, "t")).toBe(1_700_000_000_000);
  });

  test("ISO-8601 strings parse", () => {
    expect(toEpochMs("2023-11-14T22:13:20.000Z", "t")).toBe(1_700_000_000_000);
  });

  test("anything else throws rather than being guessed at", () => {
    expect(() => toEpochMs(undefined, "an event's timestamp")).toThrow(AgentCoreTraceError);
    expect(() => toEpochMs("not a date", "an event's timestamp")).toThrow(/not a usable timestamp/);
    expect(() => toEpochMs(Number.NaN, "an event's timestamp")).toThrow(/moves every temporal window/);
  });
});

describe("coerceFields — arbitrary JSON into trace values", () => {
  test("scalars, nesting and arrays survive", () => {
    const { fields } = coerceFields({ a: 1, b: "x", c: true, d: [1, 2], e: { f: "g" } });
    expect(fields).toEqual({ a: 1, b: "x", c: true, d: [1, 2], e: { f: "g" } });
  });

  test("a non-integer becomes a Cedar decimal rather than being rounded", () => {
    const { fields } = coerceFields({ price: 1.5 });
    expect(renderValue(fields.price!)).toBe("1.5");
  });

  test("a number JS would print in exponential form still becomes a decimal literal", () => {
    // String(1e-7) is "1e-7", which is not a decimal literal — that used to
    // abort the whole fetch over a legitimate payload.
    expect(decimalText(1e-7)).toBe("0.0000001");
    expect(decimalText(1.5)).toBe("1.5");
    expect(decimalText(-2.5e-8)).toBe("-0.000000025");
    expect(renderValue(coerceFields({ tiny: 1e-7 }).fields.tiny!)).toBe("0.0000001");
  });

  test("a value too small to spell exactly throws instead of rounding to 0.0", () => {
    expect(() => coerceFields({ tiny: 1e-25 })).toThrow(/at tiny/);
    expect(() => coerceFields({ tiny: 1e-25 })).toThrow(/a number the agent never saw/);
  });

  test("null and undefined are dropped from records — Cedar has no null", () => {
    const { fields } = coerceFields({ a: null, b: undefined, c: 1 });
    expect(fields).toEqual({ c: 1 });
  });

  test("a null inside an array throws, because dropping it would shift every later index", () => {
    expect(() => coerceFields({ args: ["a", null, "c"] })).toThrow(
      /would shift every later element/,
    );
    expect(() => coerceFields({ args: ["a", null] })).toThrow(/args\[1\]/);
  });

  test("two keys that spell the same identifier throw rather than one overwriting the other", () => {
    expect(() => coerceFields({ "tool-name": 1, "tool.name": 2 })).toThrow(
      /both spell "tool_name"/,
    );
    expect(() => coerceFields({ tool_name: 1, "tool-name": 2 })).toThrow(AgentCoreTraceError);
  });

  test("a key the grammar cannot spell is rewritten, and the rewrite is reported", () => {
    const { fields, renames } = coerceFields({ "tool-name": "transfer", nested: { "2fa": true } });
    expect(fields).toEqual({ tool_name: "transfer", nested: { f_2fa: true } });
    expect(renames).toEqual([
      { path: "tool-name", from: "tool-name", to: "tool_name" },
      { path: "nested.2fa", from: "2fa", to: "f_2fa" },
    ]);
  });

  test("onNonIdentifierField: \"fail\" refuses instead of rewriting", () => {
    expect(() => coerceFields({ "tool-name": "x" }, { onNonIdentifierField: "fail" })).toThrow(
      /cannot spell it/,
    );
  });

  test("identifierFor is deterministic", () => {
    expect(identifierFor("tool-name")).toBe("tool_name");
    expect(identifierFor("2fa")).toBe("f_2fa");
    expect(identifierFor("ok_name")).toBe("ok_name");
  });
});

describe("normalizeMemoryEvents — ListEvents output into normalized events", () => {
  test("a blob payload maps action/kind/input/output/error and the rest to attributes", () => {
    const { events } = normalizeMemoryEvents([
      memoryEvent({
        payload: [
          {
            blob: {
              action: "Transfer",
              kind: "request",
              input: { amount: 10 },
              output: { ok: true },
              toolVersion: "3",
            },
          },
        ],
      }),
    ]);

    expect(events).toEqual([
      {
        timeMs: 1_700_000_000_000,
        sessionId: "sess-1",
        eventId: "evt-1",
        actor: "alice",
        target: "mem-1",
        action: "Transfer",
        kind: "request",
        input: { amount: 10 },
        output: { ok: true },
        attributes: { toolVersion: "3" },
      },
    ]);
  });

  test("a conversational payload maps the role to an action and kind", () => {
    const { events } = normalizeMemoryEvents([
      memoryEvent({ payload: [{ conversational: { role: "TOOL", content: { text: "called" } } }] }),
    ]);
    expect(events[0]).toMatchObject({
      action: "InvokeTool",
      kind: "request",
      input: { text: "called" },
      attributes: { role: "TOOL" },
    });
  });

  test("an unknown role falls back to OTHER, and the role is preserved in attributes", () => {
    const { events } = normalizeMemoryEvents([
      memoryEvent({ payload: [{ conversational: { role: "SYSTEM", content: { text: "x" } } }] }),
    ]);
    expect(events[0]).toMatchObject({ action: "Event", kind: "request", attributes: { role: "SYSTEM" } });
  });

  test("the role mapping is overridable", () => {
    const { events } = normalizeMemoryEvents(
      [memoryEvent({ payload: [{ conversational: { role: "USER", content: { text: "hi" } } }] })],
      { roles: { USER: { action: "Ask", kind: "prompt" } } },
    );
    expect(events[0]).toMatchObject({ action: "Ask", kind: "prompt" });
  });

  test("a multi-member payload becomes one event per member, with distinct ids", () => {
    const { events } = normalizeMemoryEvents([
      memoryEvent({
        payload: [
          { blob: { action: "Transfer", input: { amount: 1 } } },
          { conversational: { role: "ASSISTANT", content: { text: "done" } } },
        ],
      }),
    ]);
    expect(events.map((e) => e.eventId)).toEqual(["evt-1#0", "evt-1#1"]);
    expect(events.map((e) => e.timeMs)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  });

  test("a non-record blob group is carried under `value`, not dropped", () => {
    // A blob is arbitrary JSON; `input: "the prompt"` is ordinary.
    const { events } = normalizeMemoryEvents([
      memoryEvent({
        payload: [{ blob: { action: "Ask", kind: "request", input: "prompt text", output: ["a", "b"] } }],
      }),
    ]);
    expect(events[0]).toMatchObject({ input: { value: "prompt text" }, output: { value: ["a", "b"] } });
  });

  test("target defaults to the memoryId and is overridable", () => {
    expect(normalizeMemoryEvents([memoryEvent()]).events[0]?.target).toBe("mem-1");
    expect(normalizeMemoryEvents([memoryEvent()], { target: "gw-1" }).events[0]?.target).toBe("gw-1");
  });

  test("renames from nested payloads are carried out", () => {
    const { renames } = normalizeMemoryEvents([
      memoryEvent({ payload: [{ blob: { action: "T", input: { "user-id": "u1" } } }] }),
    ]);
    expect(renames).toEqual([
      { path: "event 0 (evt-1).payload[0].blob.input.user-id", from: "user-id", to: "user_id" },
    ]);
  });
});

describe("a malformed history fails loudly", () => {
  test("an empty payload throws rather than producing a payload-less trace", () => {
    expect(() => normalizeMemoryEvents([memoryEvent({ payload: [] })])).toThrow(
      /has an empty payload/,
    );
    expect(() => normalizeMemoryEvents([memoryEvent({ payload: undefined })])).toThrow(
      AgentCoreTraceError,
    );
  });

  test("a payload member that is neither conversational nor blob throws", () => {
    expect(() =>
      normalizeMemoryEvents([memoryEvent({ payload: [{} as never] })]),
    ).toThrow(/neither conversational nor blob/);
  });

  test("…and says why skipping it would be worse", () => {
    expect(() => normalizeMemoryEvents([memoryEvent({ payload: [{} as never] })])).toThrow(
      /drop a decision point from the replay/,
    );
  });

  test("a missing timestamp names the offending event", () => {
    expect(() => normalizeMemoryEvents([memoryEvent({ eventTimestamp: undefined })])).toThrow(
      /event 0 \(evt-1\)'s eventTimestamp/,
    );
  });

  test("an event with no actorId is refused by the renderer, not smuggled through", async () => {
    const { http } = mockHttp([{ body: { events: [memoryEvent({ actorId: undefined })] } }]);
    await expect(awsAgentCoreFetchTrace(BASE, undefined, http)).rejects.toThrow(/has no actor/);
  });
});

describe("listMemoryEvents — transport", () => {
  test("POSTs the documented Memory route with includePayloads", async () => {
    const { http, calls } = mockHttp([{ body: { events: [memoryEvent()] } }]);
    await listMemoryEvents(BASE, undefined, http);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:4566/memories/mem-1/actor/alice/sessions/sess-1");
    expect(calls[0]?.body).toMatchObject({ includePayloads: true, maxResults: 100 });
  });

  test("the endpoint override is what retargets it; without one it is the regional host", async () => {
    const { http, calls } = mockHttp([{ body: { events: [] } }]);
    await listMemoryEvents({ ...BASE, endpoint: undefined, region: "eu-west-1" }, undefined, http);
    expect(calls[0]?.url).toBe(
      "https://bedrock-agentcore.eu-west-1.amazonaws.com/memories/mem-1/actor/alice/sessions/sess-1",
    );
  });

  test("path segments are encoded", async () => {
    const { http, calls } = mockHttp([{ body: { events: [] } }]);
    await listMemoryEvents({ ...BASE, sessionId: "a/b c" }, undefined, http);
    expect(calls[0]?.url).toBe("http://localhost:4566/memories/mem-1/actor/alice/sessions/a%2Fb%20c");
  });

  test("pagination follows nextToken to exhaustion", async () => {
    const { http, calls } = mockHttp([
      { body: { events: [memoryEvent({ eventId: "a" })], nextToken: "t1" } },
      { body: { events: [memoryEvent({ eventId: "b" })] } },
    ]);
    const events = await listMemoryEvents(BASE, undefined, http);

    expect(events.map((e) => e.eventId)).toEqual(["a", "b"]);
    expect(calls[1]?.body).toMatchObject({ nextToken: "t1" });
  });

  test("maxEvents caps the fetch and shrinks the last page request", async () => {
    const { http, calls } = mockHttp([
      { body: { events: [memoryEvent({ eventId: "a" }), memoryEvent({ eventId: "b" })], nextToken: "t1" } },
      { body: { events: [memoryEvent({ eventId: "c" })] } },
    ]);
    const events = await listMemoryEvents({ ...BASE, maxEvents: 3 }, undefined, http);

    expect(events).toHaveLength(3);
    expect(calls[0]?.body.maxResults).toBe(3);
    expect(calls[1]?.body.maxResults).toBe(1);
  });

  test("an empty page ends the walk even when a token comes back", async () => {
    const { http, calls } = mockHttp([{ body: { events: [], nextToken: "forever" } }]);
    expect(await listMemoryEvents(BASE, undefined, http)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a service error becomes a typed AwsReadError carrying the __type", async () => {
    const { http } = mockHttp([
      { status: 404, body: { __type: "com.amazon#ResourceNotFoundException", message: "no such memory" } },
    ]);
    await expect(listMemoryEvents(BASE, undefined, http)).rejects.toMatchObject({
      name: "AwsReadError",
      code: "ResourceNotFoundException",
      message: "no such memory",
    });
  });

  test("an unparseable body is a failed read, not an empty session", async () => {
    const http: AwsReadHttp = async () => ({ status: 200, text: "<html>gateway timeout</html>" });
    await expect(listMemoryEvents(BASE, undefined, http)).rejects.toBeInstanceOf(AwsReadError);
  });

  test("maxEvents below 1 is refused, since ListEvents bounds maxResults at 1..100", async () => {
    const { http, calls } = mockHttp([{ body: { events: [] } }]);
    await expect(listMemoryEvents({ ...BASE, maxEvents: 0 }, undefined, http)).rejects.toThrow(
      /maxEvents must be a positive integer/,
    );
    expect(calls).toHaveLength(0);
  });

  test("a missing identifier is refused before any request goes out", async () => {
    const { http, calls } = mockHttp([{ body: { events: [] } }]);
    await expect(listMemoryEvents({ ...BASE, memoryId: "" }, undefined, http)).rejects.toThrow(
      /memoryId is required/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("awsAgentCoreFetchTrace — fetch to trace text", () => {
  test("renders the fetched history with both bags populated and the action qualified", async () => {
    const { http } = mockHttp([
      {
        body: {
          events: [
            memoryEvent({
              eventId: "u1",
              eventTimestamp: 1_700_000_000,
              payload: [{ blob: { action: "Login", kind: "request", input: { user: "alice" } } }],
            }),
          ],
        },
      },
    ]);

    const result = await awsAgentCoreFetchTrace(
      { ...BASE, namespace: "Drupe", principalType: "OAuthUser", resourceType: "Gateway", origin: "relative-seconds" },
      undefined,
      http,
    );

    expect(result.text).toBe(
      '@0 scope(principal: Drupe::OAuthUser::"alice", resource: Drupe::Gateway::"mem-1") ' +
        'request_context(input: { user: "alice" }) ' +
        'Drupe::Action::"Login"::request(input: { user: "alice" }, ' +
        'callerPrincipal: Drupe::OAuthUser::"alice", callerResource: Drupe::Gateway::"mem-1", ' +
        'sessionId: "sess-1", requestId: "u1")\n',
    );
    expect(result).toMatchObject({ source: "memory", sessionId: "sess-1", lineCount: 1, fetched: 1 });
  });

  test("the window is applied after the fetch, because ListEvents has no time filter", async () => {
    const { http, calls } = mockHttp([
      {
        body: {
          events: [
            memoryEvent({ eventId: "old", eventTimestamp: 1_000 }),
            memoryEvent({ eventId: "keep", eventTimestamp: 2_000 }),
            memoryEvent({ eventId: "new", eventTimestamp: 3_000 }),
          ],
        },
      },
    ]);

    // The bounds go through the same reader the event timestamps do, so a
    // bound is never on a different scale from what it is compared against.
    const result = await awsAgentCoreFetchTrace({ ...BASE, since: 2_000, until: 2_000 }, undefined, http);

    expect(calls[0]?.body).not.toHaveProperty("filter");
    expect(result.fetched).toBe(3);
    expect(result.lineCount).toBe(1);
    expect(result.text).toContain('requestId: "keep"');
  });

  test("an event outside the window cannot fail the run", async () => {
    // The window is applied before normalizing, so a payload-less record the
    // caller deliberately excluded is not a reason to abort.
    const { http } = mockHttp([
      {
        body: {
          events: [
            memoryEvent({ eventId: "broken", eventTimestamp: 1_000, payload: [] }),
            memoryEvent({ eventId: "keep", eventTimestamp: 2_000 }),
          ],
        },
      },
    ]);
    const result = await awsAgentCoreFetchTrace({ ...BASE, since: 2_000 }, undefined, http);
    expect(result.lineCount).toBe(1);
    expect(result.text).toContain('requestId: "keep"');
  });

  test("…but one inside the window still fails the run", async () => {
    const { http } = mockHttp([
      { body: { events: [memoryEvent({ eventId: "broken", eventTimestamp: 2_000, payload: [] })] } },
    ]);
    await expect(awsAgentCoreFetchTrace({ ...BASE, since: 2_000 }, undefined, http)).rejects.toThrow(
      /has an empty payload/,
    );
  });

  test("an ISO window bound is accepted", async () => {
    const { http } = mockHttp([
      { body: { events: [memoryEvent({ eventTimestamp: "2023-11-14T22:13:20.000Z" })] } },
    ]);
    const result = await awsAgentCoreFetchTrace(
      { ...BASE, since: "2023-11-14T00:00:00.000Z", until: "2023-11-15T00:00:00.000Z" },
      undefined,
      http,
    );
    expect(result.lineCount).toBe(1);
  });

  test("an empty window throws, naming the Memory caveat rather than shrugging", async () => {
    const { http } = mockHttp([{ body: { events: [memoryEvent({ eventTimestamp: 1_000 })] } }]);
    await expect(
      awsAgentCoreFetchTrace({ ...BASE, since: 9_000_000_000_000 }, undefined, http),
    ).rejects.toThrow(/holds what the agent wrote through CreateEvent/);
  });

  test("requireEvents: false accepts an empty trace", async () => {
    const { http } = mockHttp([{ body: { events: [] } }]);
    const result = await awsAgentCoreFetchTrace({ ...BASE, requireEvents: false }, undefined, http);
    expect(result).toMatchObject({ text: "", lineCount: 0, fetched: 0 });
  });

  test("outPath writes the trace PolicyReplayOp reads, and reports the absolute path", async () => {
    const { http } = mockHttp([{ body: { events: [memoryEvent()] } }]);
    const dir = await mkdtemp(join(tmpdir(), "chant-agentcore-"));
    const outPath = join(dir, "nested", "session.log");

    const result = await awsAgentCoreFetchTrace({ ...BASE, outPath }, undefined, http);

    expect(result.outPath).toBe(outPath);
    expect(await readFile(outPath, "utf8")).toBe(result.text);
  });

  test("renames are surfaced on the result rather than happening silently", async () => {
    const { http } = mockHttp([
      { body: { events: [memoryEvent({ payload: [{ blob: { action: "T", input: { "user-id": "u1" } } }] })] } },
    ]);
    const result = await awsAgentCoreFetchTrace(BASE, undefined, http);
    expect(result.renames).toHaveLength(1);
    expect(result.text).toContain('input: { user_id: "u1" }');
  });

  test("a decision-kind event with no payload is refused, not rendered weak", async () => {
    const { http } = mockHttp([{ body: { events: [memoryEvent({ payload: [{ blob: { action: "Ping" } }] })] } }]);
    await expect(awsAgentCoreFetchTrace(BASE, undefined, http)).rejects.toThrow(
      /request_context envelope would be empty/,
    );
  });

  test("…and `allow` is the way to say the weakening is the point", async () => {
    const { http } = mockHttp([{ body: { events: [memoryEvent({ payload: [{ blob: { action: "Ping" } }] })] } }]);
    const result = await awsAgentCoreFetchTrace(
      { ...BASE, allow: ["no-request-context"] },
      undefined,
      http,
    );
    expect(result.issues.map((i) => i.kind)).toEqual(["no-request-context"]);
  });
});

describe("sources this module refuses rather than guesses at (#1685 investigation)", () => {
  test("gateway-logs names the CloudWatch finding and the non-JSON requestBody", async () => {
    const { http, calls } = mockHttp([{ body: { events: [] } }]);
    const promise = awsAgentCoreFetchTrace({ ...BASE, source: "gateway-logs" }, undefined, http);

    await expect(promise).rejects.toBeInstanceOf(AgentCoreTraceUnavailableError);
    await expect(promise).rejects.toThrow(/vendedlogs\/bedrock-agentcore\/gateway/);
    await expect(promise).rejects.toThrow(/Java map toString/);
    expect(calls).toHaveLength(0);
  });

  test("spans names the policy-decision span attribute and the Transaction Search requirement", async () => {
    const { http } = mockHttp([{ body: { events: [] } }]);
    const promise = awsAgentCoreFetchTrace({ ...BASE, source: "spans" }, undefined, http);

    await expect(promise).rejects.toThrow(/aws\.agentcore\.policy\.authorization_decision/);
    await expect(promise).rejects.toThrow(/Transaction\s+Search/);
  });

  test("the error carries the source, so a caller can branch on it", async () => {
    const { http } = mockHttp([{ body: { events: [] } }]);
    try {
      await awsAgentCoreFetchTrace({ ...BASE, source: "spans" }, undefined, http);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as AgentCoreTraceUnavailableError).source).toBe("spans");
    }
  });
});
