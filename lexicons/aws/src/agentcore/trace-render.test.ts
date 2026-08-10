import { describe, test, expect } from "vitest";
import {
  agentCoreDecimal,
  agentCoreEntityRef,
  agentCoreRaw,
  auditAgentCoreEvents,
  AgentCoreTraceError,
  qualifyAction,
  qualifyUid,
  renderAgentCoreTrace,
  renderFields,
  renderValue,
  toTraceLine,
  renderTraceLine,
  type AgentCoreSessionEvent,
} from "./trace-render";

/**
 * The golden line every assertion below is measured against is the real one
 * quoted in the #1657 verification §6, reproduced here so a drift in the
 * grammar shows up as a diff against a line that was read off dogwood's own
 * parser rather than against this module's own opinion:
 *
 * ```
 * @0 scope(principal: Drupe::OAuthUser::"alice", resource: Drupe::Gateway::"gw1") request_context(input: { user: "alice" }) Drupe::Action::"Login"::request(input: { user: "alice" }, callerPrincipal: Drupe::OAuthUser::"alice", callerResource: Drupe::Gateway::"gw1", requestId: "u1")
 * ```
 */

function event(over: Partial<AgentCoreSessionEvent> = {}): AgentCoreSessionEvent {
  return {
    timeMs: 0,
    sessionId: "s-1",
    eventId: "u1",
    kind: "request",
    action: "Login",
    actor: "alice",
    target: "gw1",
    input: { user: "alice" },
    ...over,
  };
}

describe("value rendering — Cedar surface forms (§6)", () => {
  test("strings are quoted and escaped", () => {
    expect(renderValue("alice")).toBe('"alice"');
    expect(renderValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(renderValue("a\\b")).toBe('"a\\\\b"');
    expect(renderValue("line\nbreak\ttab\rcr")).toBe('"line\\nbreak\\ttab\\rcr"');
  });

  test("a URL survives, because a trace has no comment syntax", () => {
    expect(renderValue("https://example.com/a//b")).toBe('"https://example.com/a//b"');
  });

  test("booleans and integers render bare", () => {
    expect(renderValue(true)).toBe("true");
    expect(renderValue(false)).toBe("false");
    expect(renderValue(42)).toBe("42");
    expect(renderValue(-7)).toBe("-7");
  });

  test("a non-integer number throws rather than losing its scale", () => {
    expect(() => renderValue(1.5)).toThrow(/agentCoreDecimal/);
  });

  test("decimals keep the scale a JS number cannot carry", () => {
    expect(renderValue(agentCoreDecimal("1.50"))).toBe("1.50");
    expect(() => agentCoreDecimal("1.5x")).toThrow(AgentCoreTraceError);
    expect(() => agentCoreDecimal("2")).toThrow(/looks like "1.50"/);
  });

  test("entity refs render as the bare uid, and must be qualified", () => {
    expect(renderValue(agentCoreEntityRef('Drupe::OAuthUser::"alice"'))).toBe('Drupe::OAuthUser::"alice"');
    expect(() => agentCoreEntityRef("alice")).toThrow(/fully qualified/);
  });

  test("raw passes through untouched", () => {
    expect(renderValue(agentCoreRaw("ip(\"10.0.0.1\")"))).toBe('ip("10.0.0.1")');
  });

  test("arrays and nested records", () => {
    expect(renderValue([1, "a", true])).toBe('[1, "a", true]');
    expect(renderFields({ a: 1, b: { c: "x" } })).toBe('{ a: 1, b: { c: "x" } }');
  });

  test("a field name that is not an identifier throws", () => {
    expect(() => renderFields({ "not-an-ident": 1 })).toThrow(/must be an identifier/);
  });
});

describe("qualification — the second §6 trap", () => {
  test("a bare action gets the namespace", () => {
    expect(qualifyAction("Transfer", "Drupe")).toBe('Drupe::Action::"Transfer"');
  });

  test("an already-qualified action is validated and passed through", () => {
    expect(qualifyAction('Drupe::Action::"Transfer"', "AgentCore")).toBe('Drupe::Action::"Transfer"');
    expect(() => qualifyAction("Drupe::Action::Transfer", "AgentCore")).toThrow(/fully qualified/);
  });

  test("a bare name that could not be quoted safely throws", () => {
    expect(() => qualifyAction('Trans"fer', "Drupe")).toThrow(/cannot be empty or contain a quote/);
    expect(() => qualifyAction("", "Drupe")).toThrow(AgentCoreTraceError);
  });

  test("uids qualify the same way", () => {
    expect(qualifyUid("alice", "Drupe", "OAuthUser", "an actor")).toBe('Drupe::OAuthUser::"alice"');
    expect(qualifyUid('Other::Type::"x"', "Drupe", "OAuthUser", "an actor")).toBe('Other::Type::"x"');
  });
});

describe("renderAgentCoreTrace — byte-level golden lines", () => {
  test("one event reproduces the §6 example line exactly", () => {
    const { text } = renderAgentCoreTrace(
      [event({ sessionId: "sess-1" })],
      { namespace: "Drupe", principalType: "OAuthUser", resourceType: "Gateway" },
    );

    expect(text).toBe(
      '@0 scope(principal: Drupe::OAuthUser::"alice", resource: Drupe::Gateway::"gw1") ' +
        'request_context(input: { user: "alice" }) ' +
        'Drupe::Action::"Login"::request(input: { user: "alice" }, ' +
        'callerPrincipal: Drupe::OAuthUser::"alice", callerResource: Drupe::Gateway::"gw1", ' +
        'sessionId: "sess-1", requestId: "u1")\n',
    );
  });

  test("every payload group lands in BOTH bags — the first §6 trap", () => {
    const [line] = renderAgentCoreTrace(
      [
        event({
          kind: "response",
          action: "Transfer",
          input: { amount: 10 },
          output: { result: "ok" },
          attributes: { toolName: "transfer" },
        }),
      ],
      { decisionKinds: ["response"] },
    ).lines;

    expect(Object.keys(line!.requestContext)).toEqual(["input", "output", "attributes"]);
    // The record carries the same groups, then the event schema's own
    // injections, which are never part of the Cedar request.
    expect(Object.keys(line!.record)).toEqual([
      "input",
      "output",
      "attributes",
      "callerPrincipal",
      "callerResource",
      "sessionId",
      "requestId",
    ]);
    for (const group of ["input", "output", "attributes"]) {
      expect(line!.record[group]).toEqual(line!.requestContext[group]);
    }
  });

  test("an error group renders into both bags too", () => {
    const { text } = renderAgentCoreTrace(
      [event({ kind: "error", input: undefined, error: { code: "AccessDenied" } })],
      { namespace: "Drupe", principalType: "OAuthUser", resourceType: "Gateway", decisionKinds: ["error"] },
    );
    expect(text).toBe(
      '@0 scope(principal: Drupe::OAuthUser::"alice", resource: Drupe::Gateway::"gw1") ' +
        'request_context(error: { code: "AccessDenied" }) ' +
        'Drupe::Action::"Login"::error(error: { code: "AccessDenied" }, ' +
        'callerPrincipal: Drupe::OAuthUser::"alice", callerResource: Drupe::Gateway::"gw1", ' +
        'sessionId: "s-1", requestId: "u1")\n',
    );
  });

  test("the default namespace and entity types", () => {
    const { text } = renderAgentCoreTrace([event({ input: { q: 1 } })]);
    expect(text).toBe(
      '@0 scope(principal: AgentCore::Actor::"alice", resource: AgentCore::Runtime::"gw1") ' +
        "request_context(input: { q: 1 }) " +
        'AgentCore::Action::"Login"::request(input: { q: 1 }, ' +
        'callerPrincipal: AgentCore::Actor::"alice", callerResource: AgentCore::Runtime::"gw1", ' +
        'sessionId: "s-1", requestId: "u1")\n',
    );
  });

  test("epoch-seconds is the default origin; relative-seconds starts the trace at @0", () => {
    const events = [
      event({ eventId: "u1", timeMs: 1_700_000_000_000 }),
      event({ eventId: "u2", timeMs: 1_700_000_010_500 }),
    ];

    const epoch = renderAgentCoreTrace(events).lines.map((l) => l.timestamp);
    expect(epoch).toEqual([1_700_000_000, 1_700_000_010]);

    const relative = renderAgentCoreTrace(events, { origin: "relative-seconds" }).lines.map((l) => l.timestamp);
    expect(relative).toEqual([0, 10]);
  });

  test("the history is ordered the way the interpreter reads it, newest-last", () => {
    // CloudWatch Logs hands out the newest first; replayed in that order the
    // temporal windows would see the future before the past.
    const { text } = renderAgentCoreTrace(
      [
        event({ eventId: "u3", timeMs: 7_200_000 }),
        event({ eventId: "u1", timeMs: 0 }),
        event({ eventId: "u2", timeMs: 10_000 }),
      ],
      { origin: "relative-seconds" },
    );
    const stamps = text.trimEnd().split("\n").map((l) => l.split(" ")[0]);
    expect(stamps).toEqual(["@0", "@10", "@7200"]);
  });

  test("a tie keeps the order the source reported", () => {
    const { lines } = renderAgentCoreTrace([
      event({ eventId: "second", timeMs: 5_000 }),
      event({ eventId: "first", timeMs: 5_000 }),
    ]);
    expect(lines.map((l) => l.record.requestId)).toEqual(["second", "first"]);
  });

  test("a multi-line trace is newline-terminated with no trailing blank", () => {
    const { text } = renderAgentCoreTrace(
      [event({ eventId: "u1", timeMs: 0 }), event({ eventId: "u2", timeMs: 1_000 })],
      { origin: "relative-seconds" },
    );
    expect(text.endsWith(")\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(3);
    expect(text.split("\n")[2]).toBe("");
  });

  test("an empty history renders as empty text, not a bare newline", () => {
    expect(renderAgentCoreTrace([]).text).toBe("");
  });
});

describe("a malformed history fails loudly rather than weakening the trace", () => {
  test("a decision-kind event with no payload is refused", () => {
    expect(() => renderAgentCoreTrace([event({ input: undefined })])).toThrow(AgentCoreTraceError);
    expect(() => renderAgentCoreTrace([event({ input: undefined })])).toThrow(
      /request_context envelope would be empty/,
    );
  });

  test("…and the refusal names the opt-out rather than leaving the caller stuck", () => {
    expect(() => renderAgentCoreTrace([event({ input: undefined })])).toThrow(
      /allow: \["no-request-context"\]/,
    );
    const { text, issues } = renderAgentCoreTrace([event({ input: undefined })], {
      allow: ["no-request-context"],
    });
    expect(issues.map((i) => i.kind)).toEqual(["no-request-context"]);
    expect(text).toContain('Login"::request(callerPrincipal:');
  });

  test("a history-only kind with no payload is not a weakening", () => {
    const { text } = renderAgentCoreTrace([event({ kind: "response", input: undefined })]);
    expect(text).toContain('::Action::"Login"::response(');
  });

  test("an empty payload group counts as no payload", () => {
    expect(() => renderAgentCoreTrace([event({ input: {} })])).toThrow(/request_context envelope would be empty/);
  });

  test("a repeated eventId within a session is refused", () => {
    const events = [event({ eventId: "u1", timeMs: 0 }), event({ eventId: "u1", timeMs: 1_000 })];
    expect(() => renderAgentCoreTrace(events)).toThrow(/reports eventId "u1" twice/);
  });

  test("the same eventId in two different sessions is fine", () => {
    const events = [
      event({ sessionId: "s-1", eventId: "u1" }),
      event({ sessionId: "s-2", eventId: "u1", timeMs: 1_000 }),
    ];
    expect(renderAgentCoreTrace(events).lines).toHaveLength(2);
  });

  test.each([
    ["timeMs", { timeMs: Number.NaN }, /no usable timestamp/],
    ["timeMs", { timeMs: undefined as unknown as number }, /no usable timestamp/],
    ["sessionId", { sessionId: "" }, /has no sessionId/],
    ["eventId", { eventId: "" }, /has no eventId/],
    ["actor", { actor: "" }, /has no actor/],
    ["target", { target: "" }, /has no target/],
    ["action", { action: "" }, /has no action/],
    ["kind", { kind: "" }, /has no kind/],
  ])("a history missing %s throws instead of guessing", (_field, over, message) => {
    expect(() => renderAgentCoreTrace([event(over as Partial<AgentCoreSessionEvent>)])).toThrow(message);
  });

  test("a kind that is not an identifier throws", () => {
    expect(() => renderAgentCoreTrace([event({ kind: "tool-call" })])).toThrow(/must be an identifier/);
  });

  test("the error names the event's position in the sorted history", () => {
    try {
      renderAgentCoreTrace([event({ timeMs: 10_000 }), event({ eventId: "u2", timeMs: 0, actor: "" })]);
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCoreTraceError);
      expect((error as AgentCoreTraceError).index).toBe(0);
    }
  });
});

describe("auditAgentCoreEvents / toTraceLine / renderTraceLine", () => {
  test("the audit reports without rendering", () => {
    const issues = auditAgentCoreEvents([event({ input: undefined })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "no-request-context", index: 0, timeMs: 0 });
  });

  test("a clean history audits empty", () => {
    expect(auditAgentCoreEvents([event()])).toEqual([]);
  });

  test("toTraceLine and renderTraceLine compose to the same line", () => {
    const line = toTraceLine(event(), 0, { namespace: "Drupe", principalType: "OAuthUser", resourceType: "Gateway" });
    expect(renderTraceLine(line) + "\n").toBe(
      renderAgentCoreTrace([event()], {
        namespace: "Drupe",
        principalType: "OAuthUser",
        resourceType: "Gateway",
      }).text,
    );
  });

  test("a non-integer timepoint throws", () => {
    const line = toTraceLine(event(), 1.5);
    expect(() => renderTraceLine(line)).toThrow(/a timepoint is an i64/);
  });
});
