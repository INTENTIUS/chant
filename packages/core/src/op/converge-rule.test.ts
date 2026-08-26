import { describe, test, expect } from "vitest";
import {
  eq, neq, gt, gte, lt, lte, truthy, falsy, allOf, anyOf,
  evaluatePredicate, isWellFormedPredicate,
  run, report, when, duplicateRuleIds,
  DEFAULT_FLAP_THRESHOLD,
} from "./converge-rule";

interface TestSymptom {
  status: string;
  count: number;
  flag: boolean;
}

const symptom: TestSymptom = { status: "drifted", count: 3, flag: true };

describe("evaluatePredicate", () => {
  test("eq matches / doesn't match", () => {
    expect(evaluatePredicate(eq<TestSymptom>("status", "drifted"), symptom)).toBe(true);
    expect(evaluatePredicate(eq<TestSymptom>("status", "reconciled"), symptom)).toBe(false);
  });

  test("neq", () => {
    expect(evaluatePredicate(neq<TestSymptom>("status", "reconciled"), symptom)).toBe(true);
    expect(evaluatePredicate(neq<TestSymptom>("status", "drifted"), symptom)).toBe(false);
  });

  test("numeric comparisons", () => {
    expect(evaluatePredicate(gt<TestSymptom>("count", 2), symptom)).toBe(true);
    expect(evaluatePredicate(gt<TestSymptom>("count", 3), symptom)).toBe(false);
    expect(evaluatePredicate(gte<TestSymptom>("count", 3), symptom)).toBe(true);
    expect(evaluatePredicate(lt<TestSymptom>("count", 4), symptom)).toBe(true);
    expect(evaluatePredicate(lt<TestSymptom>("count", 3), symptom)).toBe(false);
    expect(evaluatePredicate(lte<TestSymptom>("count", 3), symptom)).toBe(true);
  });

  test("numeric comparison against a non-number field never throws, just doesn't match", () => {
    expect(evaluatePredicate(gt<TestSymptom>("status" as never, 1), symptom)).toBe(false);
  });

  test("truthy / falsy", () => {
    expect(evaluatePredicate(truthy<TestSymptom>("flag"), symptom)).toBe(true);
    expect(evaluatePredicate(falsy<TestSymptom>("flag"), symptom)).toBe(false);
    expect(evaluatePredicate(truthy<TestSymptom>("count"), { ...symptom, count: 0 })).toBe(false);
  });

  test("allOf requires every predicate to match", () => {
    expect(evaluatePredicate(allOf<TestSymptom>(eq("status", "drifted"), gt("count", 2)), symptom)).toBe(true);
    expect(evaluatePredicate(allOf<TestSymptom>(eq("status", "drifted"), gt("count", 10)), symptom)).toBe(false);
  });

  test("anyOf requires at least one predicate to match", () => {
    expect(evaluatePredicate(anyOf<TestSymptom>(eq("status", "reconciled"), gt("count", 2)), symptom)).toBe(true);
    expect(evaluatePredicate(anyOf<TestSymptom>(eq("status", "reconciled"), gt("count", 10)), symptom)).toBe(false);
  });

  test("nested allOf/anyOf compose", () => {
    const p = allOf<TestSymptom>(truthy("flag"), anyOf(eq("status", "reconciled"), gt("count", 1)));
    expect(evaluatePredicate(p, symptom)).toBe(true);
  });
});

describe("isWellFormedPredicate", () => {
  test("accepts every builder's output", () => {
    expect(isWellFormedPredicate(eq<TestSymptom>("status", "x"))).toBe(true);
    expect(isWellFormedPredicate(neq<TestSymptom>("status", "x"))).toBe(true);
    expect(isWellFormedPredicate(gt<TestSymptom>("count", 1))).toBe(true);
    expect(isWellFormedPredicate(truthy<TestSymptom>("flag"))).toBe(true);
    expect(isWellFormedPredicate(falsy<TestSymptom>("flag"))).toBe(true);
    expect(isWellFormedPredicate(allOf<TestSymptom>(eq("status", "x"), truthy("flag")))).toBe(true);
    expect(isWellFormedPredicate(anyOf<TestSymptom>(eq("status", "x")))).toBe(true);
  });

  test("rejects a malformed shape", () => {
    expect(isWellFormedPredicate(null)).toBe(false);
    expect(isWellFormedPredicate("eq(status, drifted)")).toBe(false);
    expect(isWellFormedPredicate({ kind: "field-comparison", field: "status", op: "regex", value: "x" })).toBe(false);
    expect(isWellFormedPredicate({ kind: "all-of", predicates: [{ kind: "bogus" }] })).toBe(false);
    expect(isWellFormedPredicate(() => true)).toBe(false);
  });

  test("respects a field whitelist", () => {
    const whitelist = new Set(["status"]);
    expect(isWellFormedPredicate(eq<TestSymptom>("status", "x"), whitelist)).toBe(true);
    expect(isWellFormedPredicate(eq<TestSymptom>("count", 1), whitelist)).toBe(false);
  });
});

describe("run / report", () => {
  test("run() builds a RunAction", () => {
    expect(run("fountain-apply")).toEqual({ kind: "run", op: "fountain-apply" });
  });
  test("report() builds a ReportAction", () => {
    expect(report("unowned resources present")).toEqual({ kind: "report", reason: "unowned resources present" });
  });
});

describe("when()", () => {
  test("builds a well-formed rule", () => {
    const rule = when<TestSymptom>(eq("status", "drifted"), run("fountain-apply"), {
      id: "drift-apply",
      why: "Re-apply on drift.",
    });
    expect(rule).toEqual({
      id: "drift-apply",
      when: { kind: "field-comparison", field: "status", op: "eq", value: "drifted" },
      then: { kind: "run", op: "fountain-apply" },
      why: "Re-apply on drift.",
    });
  });

  test("throws without an id", () => {
    expect(() => when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "", why: "because" })).toThrow(/non-empty `id`/);
  });

  test("throws without a why", () => {
    expect(() => when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "r1", why: "" })).toThrow(/carry its `why`/);
  });

  test("throws without a why (whitespace only)", () => {
    expect(() => when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "r1", why: "   " })).toThrow(/carry its `why`/);
  });

  test("throws on a non-positive-integer flapThreshold", () => {
    expect(() => when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "r1", why: "y", flapThreshold: 0 })).toThrow(/flapThreshold/);
    expect(() => when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "r1", why: "y", flapThreshold: 1.5 })).toThrow(/flapThreshold/);
  });

  test("flapThreshold defaults are left to the caller (DEFAULT_FLAP_THRESHOLD is exported for that)", () => {
    expect(DEFAULT_FLAP_THRESHOLD).toBeGreaterThan(0);
    const rule = when<TestSymptom>(eq("status", "drifted"), run("x"), { id: "r1", why: "y" });
    expect(rule.flapThreshold).toBeUndefined();
  });
});

describe("duplicateRuleIds", () => {
  test("empty when every id is unique", () => {
    const rules = [
      when<TestSymptom>(eq("status", "a"), report("x"), { id: "r1", why: "y" }),
      when<TestSymptom>(eq("status", "b"), report("x"), { id: "r2", why: "y" }),
    ];
    expect(duplicateRuleIds(rules)).toEqual([]);
  });

  test("reports every id used more than once, sorted", () => {
    const rules = [
      when<TestSymptom>(eq("status", "a"), report("x"), { id: "r2", why: "y" }),
      when<TestSymptom>(eq("status", "b"), report("x"), { id: "r1", why: "y" }),
      when<TestSymptom>(eq("status", "c"), report("x"), { id: "r1", why: "y" }),
      when<TestSymptom>(eq("status", "d"), report("x"), { id: "r2", why: "y" }),
    ];
    expect(duplicateRuleIds(rules)).toEqual(["r1", "r2"]);
  });
});
