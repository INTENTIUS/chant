/**
 * Trace construction (#1661).
 *
 * The line grammar is #1657 §6, read from `interpreter/log_parse.rs` at the
 * pinned SHA. The tests that matter most are not the rendering ones — they are
 * the two traps, because both produce a *green* replay rather than a failing
 * one: a field in only one bag, and an action name that is not fully
 * qualified.
 */
import { describe, expect, test } from "vitest";
import {
  auditTrace,
  decimalValue,
  entityRef,
  rawValue,
  renderTrace,
  renderTraceLine,
  renderTraceValue,
  traceEntity,
  traceEvent,
  traceFixture,
} from "./trace";

const ALICE = 'Drupe::OAuthUser::"alice"';
const GATEWAY = 'Drupe::Gateway::"gw1"';

function login(over: Partial<Parameters<typeof traceEvent>[0]> = {}) {
  return traceEvent({
    timestamp: 0,
    action: 'Drupe::Action::"Login"',
    scope: { principal: ALICE, resource: GATEWAY },
    context: { input: { user: "alice" } },
    record: { callerPrincipal: entityRef(ALICE), requestId: "u1" },
    ...over,
  });
}

// ── The line grammar ───────────────────────────────────────────────

describe("renderTraceLine", () => {
  test("renders the envelopes in the one order the parser accepts", () => {
    const line = renderTraceLine(
      traceEvent({
        timestamp: 0,
        action: 'Drupe::Action::"Login"',
        scope: { principal: ALICE, resource: GATEWAY },
        entities: [traceEntity(ALICE, { id: "alice" }, ['Drupe::Gateway::"gw1"'])],
        context: { input: { user: "alice" } },
        record: { requestId: "u1" },
      }),
    );

    expect(line).toBe(
      `@0 scope(principal: ${ALICE}, resource: ${GATEWAY}) ` +
        `entities(${ALICE}: { id: "alice" } in [${GATEWAY}]) ` +
        `request_context(input: { user: "alice" }) ` +
        `Drupe::Action::"Login"::request(input: { user: "alice" }, requestId: "u1")`,
    );
  });

  test("every envelope is optional", () => {
    const line = renderTraceLine({
      timestamp: 42,
      action: 'Drupe::Action::"Read"',
      kind: "response",
      record: { requestId: "u9" },
    });
    expect(line).toBe(`@42 Drupe::Action::"Read"::response(requestId: "u9")`);
  });

  test("a whole trace is one event per line, newline-terminated", () => {
    const text = renderTrace([login(), login({ timestamp: 10, kind: "response" })]);
    expect(text.split("\n")).toHaveLength(3);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("values", () => {
  test("Cedar surface forms, by JS type", () => {
    expect(renderTraceValue("a")).toBe('"a"');
    expect(renderTraceValue(7)).toBe("7");
    expect(renderTraceValue(true)).toBe("true");
    expect(renderTraceValue([1, "a"])).toBe('[1, "a"]');
    expect(renderTraceValue({ a: 1 })).toBe("{ a: 1 }");
  });

  test("an entity reference renders unquoted", () => {
    expect(renderTraceValue(entityRef(ALICE))).toBe(ALICE);
  });

  test("a decimal keeps its scale, which a JS number cannot", () => {
    expect(renderTraceValue(decimalValue("1.50"))).toBe("1.50");
    // The failure mode this exists to prevent: 1.50 as a number is 1.5.
    expect(() => renderTraceValue(1.5)).toThrow(/decimalValue/);
  });

  test("raw text passes through, for shapes this module has no type for", () => {
    expect(renderTraceValue(rawValue("ip(\"10.0.0.1\")"))).toBe('ip("10.0.0.1")');
  });

  test("a value containing // survives, because the format has no comments", () => {
    expect(renderTraceValue("https://example.test/a")).toBe('"https://example.test/a"');
  });

  test("quotes and backslashes are escaped, not dropped", () => {
    expect(renderTraceValue('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
  });
});

// ── Trap 1: the action must be fully qualified ─────────────────────

describe("fully-qualified actions", () => {
  test("a short action name is rejected at construction", () => {
    // The trap: a bare name leaves every temporal predicate unmatched while
    // Cedar still authorizes, so the replay is green and tested nothing.
    expect(() => traceEvent({ timestamp: 0, action: "Transfer", record: {} })).toThrow(
      /fully qualified/,
    );
    expect(() => traceEvent({ timestamp: 0, action: '"Transfer"', record: {} })).toThrow(
      /fully qualified/,
    );
  });

  test("so is a short entity reference, in scope or in value position", () => {
    expect(() => entityRef("alice")).toThrow(/fully qualified/);
    expect(() =>
      traceEvent({
        timestamp: 0,
        action: 'Drupe::Action::"Read"',
        scope: { principal: "alice", resource: GATEWAY },
        record: {},
      }),
    ).toThrow(/fully qualified/);
  });
});

// ── Trap 2: both bags ──────────────────────────────────────────────

describe("both-bag population", () => {
  test("a context group is written to the envelope AND the logged record", () => {
    const event = login();
    expect(event.requestContext).toEqual({ input: { user: "alice" } });
    expect(event.record).toMatchObject({ input: { user: "alice" } });
  });

  test("record-only fields stay out of the Cedar request", () => {
    const event = login();
    expect(event.requestContext).not.toHaveProperty("requestId");
    expect(event.record).toHaveProperty("requestId");
  });

  test("the weaker forms exist, but have to be typed out", () => {
    const recordOnly = login({ bags: "record-only" });
    expect(recordOnly.requestContext).toBeUndefined();
    expect(recordOnly.record).toHaveProperty("input");

    const contextOnly = login({ bags: "context-only" });
    expect(contextOnly.requestContext).toHaveProperty("input");
    expect(contextOnly.record).not.toHaveProperty("input");
  });
});

describe("auditTrace", () => {
  test("a trace built the default way has nothing to report", () => {
    expect(auditTrace([login(), login({ timestamp: 10 })])).toEqual([]);
  });

  test("a record-only decision event is a single-bag finding", () => {
    const issues = auditTrace([login({ bags: "record-only" })]);
    expect(issues.map((i) => i.kind)).toContain("no-request-context");
  });

  test("a context-only decision event is a single-bag finding", () => {
    const issues = auditTrace([login({ bags: "context-only" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("single-bag");
    expect(issues[0].message).toMatch(/temporal predicates over input\.\* silently miss/);
  });

  test("a history-only event needs no request context — it never becomes one", () => {
    // `response` does not decide under the default event schema, so an absent
    // envelope there is not a weakening. Only the deciding kinds are held to it.
    const historyOnly = traceEvent({
      timestamp: 0,
      action: 'Drupe::Action::"Login"',
      kind: "response",
      bags: "record-only",
      context: { input: { user: "alice" } },
      record: { requestId: "u1" },
    });
    expect(auditTrace([historyOnly])).toEqual([]);
    // …but say `response` decides, and it is held to the same bar.
    expect(auditTrace([historyOnly], { decisionKinds: ["response"] })).not.toEqual([]);
  });

  test("an out-of-order timestamp is reported — history accumulates in file order", () => {
    const issues = auditTrace([login({ timestamp: 10 }), login({ timestamp: 0 })]);
    expect(issues.map((i) => i.kind)).toEqual(["out-of-order"]);
  });

  test("an event that logs nothing can match no predicate", () => {
    const empty = traceEvent({
      timestamp: 0,
      action: 'Drupe::Action::"Read"',
      context: { input: { user: "alice" } },
      bags: "context-only",
    });
    expect(auditTrace([empty]).map((i) => i.kind).sort()).toEqual(["empty-record", "single-bag"]);
  });
});

describe("traceFixture", () => {
  test("hands back the text when the trace is honest", () => {
    const fixture = traceFixture([login(), login({ timestamp: 10 })]);
    expect(fixture.issues).toEqual([]);
    expect(fixture.text.split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("refuses a fixture that would weaken its own replay", () => {
    expect(() => traceFixture([login({ bags: "context-only" })])).toThrow(/weaken its own replay/);
  });

  test("…unless the weakening is named, which is the point of naming it", () => {
    const fixture = traceFixture([login({ bags: "context-only" })], { allow: ["single-bag"] });
    expect(fixture.issues.map((i) => i.kind)).toEqual(["single-bag"]);
  });

  test("the error names the allow-list entry that would silence it", () => {
    expect(() => traceFixture([login({ bags: "context-only" })])).toThrow(/allow: \["single-bag"\]/);
  });
});
