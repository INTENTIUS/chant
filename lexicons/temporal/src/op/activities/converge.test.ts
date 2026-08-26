import { describe, test, expect } from "vitest";
import { eq, gt, run, report, when } from "@intentius/chant/op";
import type { ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
import type { ConvergeTickRecord } from "@intentius/chant/lifecycle/converge-ledger";
import { planConvergeTick, type SerializedConvergeRule } from "./converge";

function symptom(overrides?: Partial<ConvergeSymptom>): ConvergeSymptom {
  return {
    env: "staging",
    status: "drifted",
    components: [],
    createCount: 0,
    updateCount: 1,
    deleteCount: 0,
    adoptCount: 0,
    runtimeCount: 0,
    effectCount: 0,
    unobservedCount: 0,
    unobservedReasons: [],
    totalCount: 1,
    ...overrides,
  };
}

function tick(overrides?: Partial<ConvergeTickRecord>): ConvergeTickRecord {
  return {
    version: 1,
    op: "converge",
    env: "staging",
    timestamp: "2026-01-01T00:00:00.000Z",
    firedRuleIds: [],
    outcomes: [],
    summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
    log: "",
    ...overrides,
  };
}

const driftApply: SerializedConvergeRule = when<ConvergeSymptom>(eq("status", "drifted"), run("fountain-apply"), {
  id: "drift-apply",
  why: "Re-apply converges drift back to declared source.",
});
const adoptReport: SerializedConvergeRule = when<ConvergeSymptom>(gt("adoptCount", 0), report("unowned resources present"), {
  id: "adopt-report",
  why: "Unowned resources are reported, never auto-claimed.",
});
const unknownReport: SerializedConvergeRule = when<ConvergeSymptom>(eq("status", "unknown"), report("environment could not be fully observed"), {
  id: "unknown-report",
  why: "unknown never remediates.",
});

describe("planConvergeTick — classification", () => {
  test("a rule whose predicate doesn't match never fires", () => {
    const plan = planConvergeTick(symptom({ status: "reconciled" }), [driftApply], [], "apply", 3);
    expect(plan.firedRuleIds).toEqual([]);
    expect(plan.outcomes).toEqual([]);
  });

  test("a matching run() rule dispatches under a permitting dial", () => {
    const plan = planConvergeTick(symptom(), [driftApply], [], "apply", 3);
    expect(plan.firedRuleIds).toEqual(["drift-apply"]);
    expect(plan.outcomes).toEqual([{ ruleId: "drift-apply", action: "ran", op: "fountain-apply" }]);
  });

  test("a matching report() rule always reports, regardless of dial", () => {
    const plan = planConvergeTick(symptom({ adoptCount: 2 }), [adoptReport], [], "observe", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "adopt-report", action: "reported", reason: "unowned resources present" }]);
  });

  test("multiple rules are evaluated independently, in authored order", () => {
    const plan = planConvergeTick(symptom({ adoptCount: 1 }), [driftApply, adoptReport], [], "apply", 3);
    expect(plan.firedRuleIds).toEqual(["drift-apply", "adopt-report"]);
    expect(plan.outcomes.map((o) => o.ruleId)).toEqual(["drift-apply", "adopt-report"]);
  });
});

describe("planConvergeTick — adopt-report semantics", () => {
  test("an adopt-count rule table only ever reports, never runs — unowned is reported, never mutated", () => {
    const plan = planConvergeTick(symptom({ status: "reconciled", updateCount: 0, adoptCount: 3 }), [adoptReport], [], "apply", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "adopt-report", action: "reported", reason: "unowned resources present" }]);
    expect(plan.outcomes.some((o) => o.action === "ran")).toBe(false);
  });
});

describe("planConvergeTick — unknown never remediates", () => {
  test("a run() rule matched while status is unknown is forced to report instead", () => {
    const alwaysRun = when<ConvergeSymptom>(eq("env", "staging"), run("fountain-apply"), { id: "always-run", why: "test" });
    const plan = planConvergeTick(symptom({ status: "unknown", unobservedReasons: ["no-credentials"] }), [alwaysRun], [], "apply", 3);
    expect(plan.outcomes).toEqual([
      { ruleId: "always-run", action: "reported", reason: expect.stringContaining("unknown never remediates") },
    ]);
  });

  test("a report() rule still reports normally when status is unknown", () => {
    const plan = planConvergeTick(symptom({ status: "unknown", unobservedReasons: ["read-failed"] }), [unknownReport], [], "apply", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "unknown-report", action: "reported", reason: "environment could not be fully observed" }]);
  });
});

describe("planConvergeTick — dial gating", () => {
  test("observe dial never dispatches a run() rule — reports instead", () => {
    const plan = planConvergeTick(symptom(), [driftApply], [], "observe", 3);
    expect(plan.outcomes).toEqual([
      { ruleId: "drift-apply", action: "reported", reason: expect.stringContaining('dial "observe"'), op: "fountain-apply" },
    ]);
  });

  test("reconcile dial dispatches a run() rule", () => {
    const plan = planConvergeTick(symptom(), [driftApply], [], "reconcile", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "drift-apply", action: "ran", op: "fountain-apply" }]);
  });
});

describe("planConvergeTick — budget enforcement", () => {
  const rules: SerializedConvergeRule[] = [
    when<ConvergeSymptom>(eq("status", "drifted"), run("op-a"), { id: "r-a", why: "test" }),
    when<ConvergeSymptom>(eq("status", "drifted"), run("op-b"), { id: "r-b", why: "test" }),
    when<ConvergeSymptom>(eq("status", "drifted"), run("op-c"), { id: "r-c", why: "test" }),
  ];

  test("dispatches up to the budget, then records the remainder as skipped-budget", () => {
    const plan = planConvergeTick(symptom(), rules, [], "apply", 2);
    expect(plan.outcomes).toEqual([
      { ruleId: "r-a", action: "ran", op: "op-a" },
      { ruleId: "r-b", action: "ran", op: "op-b" },
      { ruleId: "r-c", action: "skipped-budget", op: "op-c" },
    ]);
  });

  test("a budget of 0 skips every run() rule", () => {
    const plan = planConvergeTick(symptom(), rules, [], "apply", 0);
    expect(plan.outcomes.every((o) => o.action === "skipped-budget")).toBe(true);
    expect(plan.outcomes).toHaveLength(3);
  });

  test("report() rules never consume budget", () => {
    const plan = planConvergeTick(symptom({ adoptCount: 1 }), [adoptReport, ...rules], [], "apply", 1);
    expect(plan.outcomes[0]).toEqual({ ruleId: "adopt-report", action: "reported", reason: "unowned resources present" });
    expect(plan.outcomes[1]).toEqual({ ruleId: "r-a", action: "ran", op: "op-a" });
    expect(plan.outcomes[2]).toEqual({ ruleId: "r-b", action: "skipped-budget", op: "op-b" });
  });
});

describe("planConvergeTick — flap damping", () => {
  test("a rule under its threshold fires normally", () => {
    const priorRecords = [tick({ firedRuleIds: ["drift-apply"] }), tick({ firedRuleIds: ["drift-apply"] })];
    const plan = planConvergeTick(symptom(), [driftApply], priorRecords, "apply", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "drift-apply", action: "ran", op: "fountain-apply" }]);
  });

  test("a rule at its default threshold (3 prior consecutive fires) escalates to skipped-flap", () => {
    const priorRecords = [
      tick({ firedRuleIds: ["drift-apply"] }),
      tick({ firedRuleIds: ["drift-apply"] }),
      tick({ firedRuleIds: ["drift-apply"] }),
    ];
    const plan = planConvergeTick(symptom(), [driftApply], priorRecords, "apply", 3);
    expect(plan.outcomes).toEqual([
      { ruleId: "drift-apply", action: "skipped-flap", reason: expect.stringContaining("threshold 3") },
    ]);
  });

  test("a cleared symptom in a prior tick resets the consecutive count", () => {
    const priorRecords = [
      tick({ firedRuleIds: ["drift-apply"] }),
      tick({ firedRuleIds: [] }),
      tick({ firedRuleIds: ["drift-apply"] }),
      tick({ firedRuleIds: ["drift-apply"] }),
    ];
    const plan = planConvergeTick(symptom(), [driftApply], priorRecords, "apply", 3);
    expect(plan.outcomes).toEqual([{ ruleId: "drift-apply", action: "ran", op: "fountain-apply" }]);
  });

  test("a custom flapThreshold is honored", () => {
    const tightRule = when<ConvergeSymptom>(eq("status", "drifted"), run("fountain-apply"), {
      id: "tight",
      why: "test",
      flapThreshold: 1,
    });
    const priorRecords = [tick({ firedRuleIds: ["tight"] })];
    const plan = planConvergeTick(symptom(), [tightRule], priorRecords, "apply", 3);
    expect(plan.outcomes[0].action).toBe("skipped-flap");
  });
});
