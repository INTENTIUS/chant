import { describe, test, expect } from "vitest";
import {
  and,
  arrayOf,
  bool,
  call,
  compare,
  count,
  ctx,
  decimalOf,
  entityUid,
  exists,
  formerly,
  int,
  interval,
  not,
  predicate,
  previous,
  raw,
  renderCondition,
  renderTerm,
  scopeRef,
  since,
  str,
  sum,
  temporalMarker,
  term,
  tp,
  typedBinder,
  varRef,
  wildcard,
} from "./temporal";
import { countDistinctWithin, countWithin, macroCondition, macroWindow, sumWithin } from "./macros";
import { renderWindow, window, windowSeconds } from "./window";

// ── Windows ────────────────────────────────────────────────────────

describe("temporal windows", () => {
  test("a window is an integer and one of the four units", () => {
    expect(window("90m")).toEqual({ value: 90, unit: "m" });
    expect(renderWindow({ value: 7, unit: "d" })).toBe("7d");
  });

  test("a unit outside s/m/h/d is refused", () => {
    // @ts-expect-error — "1w" is not assignable to WindowLike
    expect(() => window("1w")).toThrow(/not a temporal window/);
  });

  test("windows are comparable across units", () => {
    expect(windowSeconds("90m")).toBe(windowSeconds({ value: 5400, unit: "s" }));
    expect(windowSeconds("2d")).toBeGreaterThan(windowSeconds("24h"));
  });
});

// ── Terms ──────────────────────────────────────────────────────────

describe("terms", () => {
  test("literals render in Cedar's surface forms", () => {
    expect(renderTerm(str('he said "hi"'))).toBe('"he said \\"hi\\""');
    expect(renderTerm(int(-3))).toBe("-3");
    expect(renderTerm(bool(true))).toBe("true");
    expect(renderTerm(decimalOf("1.50"))).toBe('decimal("1.50")');
    expect(renderTerm(wildcard())).toBe("*");
    expect(renderTerm(arrayOf(1, 2, str("x")))).toBe('[1, 2, "x"]');
  });

  test("a non-integer is refused rather than silently truncated", () => {
    expect(() => int(1.5)).toThrow(/whole number/);
  });

  test("paths and UIDs are distinct constructions, not guessed from a string", () => {
    expect(renderTerm(ctx("input.user"))).toBe("context.input.user");
    expect(renderTerm(scopeRef("principal", "dept"))).toBe("principal.dept");
    expect(renderTerm(entityUid('Drupe::OAuthUser::"alice"'))).toBe('Drupe::OAuthUser::"alice"');
    expect(renderTerm(varRef("total"))).toBe("total");
  });

  test("a malformed entity UID is refused at construction", () => {
    expect(() => entityUid("Drupe::OAuthUser")).toThrow(/entity UID/);
  });
});

// ── The parser primitives ──────────────────────────────────────────

describe("predicates", () => {
  test("action, kind and named arguments", () => {
    const node = predicate('Drupe::Action::"Login"', "response", { "input.user": ctx("input.user") });
    expect(renderCondition(node)).toBe(
      'Drupe::Action::"Login"::response{ input.user: context.input.user }',
    );
  });

  test("no arguments still renders the mandatory braces", () => {
    expect(renderCondition(predicate('Drupe::Action::"Login"', "request"))).toBe(
      'Drupe::Action::"Login"::request{}',
    );
  });

  test("an unqualified action is refused", () => {
    expect(() => predicate("Login", "request")).toThrow(/predicate action/);
  });

  test("a field path must be dotted identifiers", () => {
    expect(() => predicate('Ns::Action::"A"', "request", { "input user": int(1) })).toThrow(/field path/);
  });
});

describe("the past-only operators", () => {
  const login = predicate('Drupe::Action::"Login"', "request");

  test("formerly and previous take their window as an argument", () => {
    expect(renderCondition(formerly("1h", login))).toBe('formerly within 1h Drupe::Action::"Login"::request{}');
    expect(renderCondition(previous("30s", login))).toBe('previous within 30s Drupe::Action::"Login"::request{}');
  });

  test("since is infix and carries the window on the operator", () => {
    const read = predicate('Drupe::Action::"Read"', "response");
    expect(renderCondition(since(read, "30m", login))).toBe(
      'Drupe::Action::"Read"::response{} since within 30m Drupe::Action::"Login"::request{}',
    );
  });

  test("a window is not optional — there is no arity that omits it", () => {
    // @ts-expect-error — formerly() has no one-argument form
    expect(() => formerly(login)).toThrow();
  });

  test("a macro body may defer the window to its call site", () => {
    expect(renderCondition(formerly(macroWindow("?w"), macroCondition("?s")))).toBe("formerly within ?w ?s");
  });
});

describe("exists, tp and the aggregates", () => {
  test("exists binds one typed variable over a condition", () => {
    const node = exists(typedBinder("total", "Long"), compare(varRef("total"), ">", 100));
    expect(renderCondition(node)).toBe("exists (total: Long). total > 100");
  });

  test("count names its aggregation domain explicitly", () => {
    const node = count(
      [typedBinder("t", "Timepoint")],
      formerly("1h", and(predicate('Ns::Action::"A"', "request"), tp("t"))),
    );
    expect(renderTerm(node)).toBe(
      'count for (t: Timepoint). where formerly within 1h (Ns::Action::"A"::request{} && tp(t))',
    );
  });

  test("sum names both its bound variable and its domain", () => {
    const node = sum(
      "a",
      [typedBinder("a", "Long"), typedBinder("t", "Timepoint")],
      predicate('Ns::Action::"A"', "request", { "input.amount": varRef("a") }),
    );
    expect(renderTerm(node)).toBe(
      'sum a for (a: Long), (t: Timepoint). where Ns::Action::"A"::request{ input.amount: a }',
    );
  });

  test("an aggregate with no for-list is refused", () => {
    expect(() => count([], raw("x"))).toThrow(/at least one typed binder/);
  });
});

// ── Precedence ─────────────────────────────────────────────────────
//
// The renderer parenthesises rather than relying on the reader knowing the
// grammar's binding rules. Each of these is a place the tree and the surface
// syntax would otherwise disagree.

describe("parenthesisation", () => {
  const a = predicate('Ns::Action::"A"', "request");
  const b = predicate('Ns::Action::"B"', "request");
  const c = predicate('Ns::Action::"C"', "request");

  test("an && chain under formerly is parenthesised (atom position)", () => {
    expect(renderCondition(formerly("1h", and(a, b)))).toBe(
      'formerly within 1h (Ns::Action::"A"::request{} && Ns::Action::"B"::request{})',
    );
  });

  test("a predicate under formerly is not", () => {
    expect(renderCondition(formerly("1h", a))).toBe('formerly within 1h Ns::Action::"A"::request{}');
  });

  test("! negates only its operand, so an && chain under it is parenthesised", () => {
    expect(renderCondition(not(and(a, b)))).toBe(
      '!(Ns::Action::"A"::request{} && Ns::Action::"B"::request{})',
    );
    expect(renderCondition(not(a))).toBe('!Ns::Action::"A"::request{}');
  });

  test("since's left operand is a neg_conjunct, so an && chain there is parenthesised", () => {
    expect(renderCondition(since(and(a, b), "1h", c))).toBe(
      '(Ns::Action::"A"::request{} && Ns::Action::"B"::request{}) since within 1h Ns::Action::"C"::request{}',
    );
  });

  test("since needs no parentheses as an && operand", () => {
    expect(renderCondition(and(since(a, "1h", b), c))).toBe(
      'Ns::Action::"A"::request{} since within 1h Ns::Action::"B"::request{} && Ns::Action::"C"::request{}',
    );
  });

  test("exists binds maximally to the right, so it is fenced inside an && chain", () => {
    const node = and(exists(typedBinder("n", "Long"), compare(varRef("n"), ">", 1)), a);
    expect(renderCondition(node)).toBe('(exists (n: Long). n > 1) && Ns::Action::"A"::request{}');
  });

  test("an aggregate in comparison position is fenced off from the operator", () => {
    const node = compare(count([typedBinder("t", "Timepoint")], a), "<", 5);
    expect(renderCondition(node)).toBe(
      '(count for (t: Timepoint). where Ns::Action::"A"::request{}) < 5',
    );
  });

  test("a single-operand and() collapses instead of emitting a bare conjunct", () => {
    expect(renderCondition(and(a))).toBe(renderCondition(a));
  });

  test("and() with nothing to conjoin is a construction error, not empty text", () => {
    expect(() => and()).toThrow(/at least one operand/);
  });
});

// ── Macro calls ────────────────────────────────────────────────────

describe("macro calls", () => {
  const a = predicate('Ns::Action::"A"', "request");

  test("a call argument may be an interval, a condition or a term", () => {
    expect(renderCondition(call("once", [interval("1h"), a]))).toBe(
      'once(1h, Ns::Action::"A"::request{})',
    );
    expect(renderCondition(call("is_small", [term("context.input.shares")]))).toBe(
      "is_small(context.input.shares)",
    );
  });

  test("the interval argument is bare — `within` belongs to the operator", () => {
    expect(renderCondition(call("once", [interval("90m")]))).not.toContain("within");
  });

  test("the default library's aggregates are calls, not operators", () => {
    expect(renderCondition(countWithin("1h", a))).toBe('count_within(1h, Ns::Action::"A"::request{})');
    expect(renderCondition(sumWithin("amount", "1h", a))).toBe(
      'sum_within(amount, 1h, Ns::Action::"A"::request{})',
    );
    expect(renderCondition(countDistinctWithin("user", "24h", a))).toBe(
      'count_distinct_within(user, 24h, Ns::Action::"A"::request{})',
    );
  });
});

// ── The extension marker ───────────────────────────────────────────

describe("the temporal marker", () => {
  test("wraps a condition for embedding mid-expression", () => {
    const marker = temporalMarker(formerly("1h", predicate('Ns::Action::"A"', "request")));
    expect(marker).toBe('temporal { formerly within 1h Ns::Action::"A"::request{} }');
  });
});

// ── The escape hatch ───────────────────────────────────────────────

describe("raw()", () => {
  test("passes text through, which is why DWDC012 reads the emitted file", () => {
    expect(renderCondition(raw("formerly Ns::Action::\"A\"::request{}"))).toBe(
      'formerly Ns::Action::"A"::request{}',
    );
  });
});
