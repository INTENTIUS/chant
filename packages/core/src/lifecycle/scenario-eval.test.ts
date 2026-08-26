import { describe, test, expect } from "vitest";
import { evaluateScenario } from "./scenario-eval";
import type { ChangeSet, ChangeSetEntry } from "./change-set";

function entry(overrides: Partial<ChangeSetEntry> & Pick<ChangeSetEntry, "name" | "action">): ChangeSetEntry {
  return {
    type: "AWS::S3::Bucket",
    evidence: { declared: true, inSnapshot: true, live: true, observed: true },
    ownership: "unknown",
    ...overrides,
  };
}

function cs(entries: ChangeSetEntry[], env = "prod"): ChangeSet {
  return { env, entries };
}

describe("evaluateScenario — noop", () => {
  test("passes when the plan proposes nothing", () => {
    const verdict = evaluateScenario(cs([entry({ name: "a", action: "noop" })]), { noop: true });
    expect(verdict.pass).toBe(true);
    expect(verdict.checks).toEqual([{ clause: "noop", pass: true }]);
  });

  test("fails and names the offending resource when the plan proposes a create", () => {
    const verdict = evaluateScenario(cs([entry({ name: "newBucket", action: "create" })]), { noop: true });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "noop")!;
    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/1 create/);
    expect(check.detail).toMatch(/newBucket/);
  });

  test("fails on an update", () => {
    const verdict = evaluateScenario(
      cs([entry({ name: "web", action: "update", deltas: [{ path: "size", oldValue: 1, newValue: 2 }] })]),
      { noop: true },
    );
    expect(verdict.pass).toBe(false);
  });

  test("fails on a delete", () => {
    const verdict = evaluateScenario(cs([entry({ name: "legacy", action: "delete", ownership: "owned" })]), {
      noop: true,
    });
    expect(verdict.pass).toBe(false);
  });

  test("ignores adopt/runtime/unobserved rows", () => {
    const verdict = evaluateScenario(
      cs([
        entry({ name: "orphan", action: "adopt" }),
        entry({ name: "child", action: "runtime", runtimeOwner: "deployment" }),
      ]),
      { noop: true },
    );
    expect(verdict.pass).toBe(true);
  });
});

describe("evaluateScenario — counts", () => {
  test("passes on an exact match across all three", () => {
    const verdict = evaluateScenario(
      cs([
        entry({ name: "a", action: "create" }),
        entry({ name: "b", action: "update" }),
        entry({ name: "c", action: "delete", ownership: "owned" }),
      ]),
      { create: 1, update: 1, delete: 1 },
    );
    expect(verdict.pass).toBe(true);
  });

  test("fails and reports the mismatched clause only", () => {
    const verdict = evaluateScenario(cs([entry({ name: "a", action: "create" }), entry({ name: "b", action: "create" })]), {
      create: 1,
    });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "create")!;
    expect(check.detail).toMatch(/expected 1 create, plan proposes 2/);
    expect(check.detail).toMatch(/a.*b|b.*a/);
  });

  test("an omitted clause is unconstrained", () => {
    const verdict = evaluateScenario(cs([entry({ name: "a", action: "update" })]), { create: 0 });
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.map((c) => c.clause)).toEqual(["create"]);
  });

  test("zero is a real assertion, not 'omitted'", () => {
    const verdict = evaluateScenario(cs([entry({ name: "a", action: "delete", ownership: "owned" })]), { delete: 0 });
    expect(verdict.pass).toBe(false);
  });
});

describe("evaluateScenario — deletes", () => {
  test("passes when every named delete matches name and ownership exactly, with no extras", () => {
    const verdict = evaluateScenario(cs([entry({ name: "legacy", action: "delete", ownership: "owned" })]), {
      deletes: [{ name: "legacy", ownership: "owned" }],
    });
    expect(verdict.pass).toBe(true);
  });

  test("fails and names the resource when an expected delete is not proposed", () => {
    const verdict = evaluateScenario(cs([]), { deletes: [{ name: "legacy", ownership: "owned" }] });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "deletes")!;
    expect(check.detail).toMatch(/"legacy"/);
    expect(check.detail).toMatch(/not proposed/);
  });

  test("fails and names the resource on an ownership mismatch", () => {
    const verdict = evaluateScenario(cs([entry({ name: "legacy", action: "delete", ownership: "foreign" })]), {
      deletes: [{ name: "legacy", ownership: "owned" }],
    });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "deletes")!;
    expect(check.detail).toMatch(/"legacy"/);
    expect(check.detail).toMatch(/expected ownership "owned", plan proposes ownership "foreign"/);
  });

  test("fails and names the resource on an unexpected extra delete", () => {
    const verdict = evaluateScenario(
      cs([
        entry({ name: "legacy", action: "delete", ownership: "owned" }),
        entry({ name: "surprise", action: "delete", ownership: "owned" }),
      ]),
      { deletes: [{ name: "legacy", ownership: "owned" }] },
    );
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "deletes")!;
    expect(check.detail).toMatch(/"surprise"/);
    expect(check.detail).toMatch(/not expected/);
  });
});

describe("evaluateScenario — unobserved", () => {
  test("\"refuse\" fails on any unobserved row", () => {
    const verdict = evaluateScenario(
      cs([entry({ name: "web", action: "unobserved", unobservedReason: "no-credentials" })]),
      { unobserved: "refuse" },
    );
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "unobserved")!;
    expect(check.detail).toMatch(/web/);
    expect(check.detail).toMatch(/no credentials/);
  });

  test("\"refuse\" passes when nothing is unobserved", () => {
    const verdict = evaluateScenario(cs([entry({ name: "web", action: "noop" })]), { unobserved: "refuse" });
    expect(verdict.pass).toBe(true);
  });

  test("{ allow } tolerates only the named entities", () => {
    const verdict = evaluateScenario(
      cs([
        entry({ name: "web", action: "unobserved", unobservedReason: "no-binding" }),
        entry({ name: "db", action: "unobserved", unobservedReason: "no-binding" }),
      ]),
      { unobserved: { allow: ["web"] } },
    );
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((c) => c.clause === "unobserved")!;
    expect(check.detail).toMatch(/db/);
    expect(check.detail).not.toMatch(/web/);
  });

  test("{ allow } passes when every unobserved entity is named", () => {
    const verdict = evaluateScenario(
      cs([entry({ name: "web", action: "unobserved", unobservedReason: "no-binding" })]),
      { unobserved: { allow: ["web"] } },
    );
    expect(verdict.pass).toBe(true);
  });

  test("omitted is unconstrained — unobserved rows neither pass nor fail it", () => {
    const verdict = evaluateScenario(
      cs([entry({ name: "web", action: "unobserved", unobservedReason: "read-failed" })]),
      { create: 0 },
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.map((c) => c.clause)).toEqual(["create"]);
  });
});

describe("evaluateScenario — composed clauses", () => {
  test("every clause is evaluated and reported, even when only one fails", () => {
    const verdict = evaluateScenario(
      cs([
        entry({ name: "legacy", action: "delete", ownership: "owned" }),
        entry({ name: "web", action: "unobserved", unobservedReason: "read-failed" }),
      ]),
      { create: 0, deletes: [{ name: "legacy", ownership: "owned" }], unobserved: "refuse" },
    );
    expect(verdict.pass).toBe(false);
    const byClause = Object.fromEntries(verdict.checks.map((c) => [c.clause, c.pass]));
    expect(byClause).toEqual({ create: true, deletes: true, unobserved: false });
  });
});
