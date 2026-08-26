/**
 * Post-synth check tests — TMP001, TMP002, TMP010, TMP011.
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { tmp001 } from "./tmp001-retention-too-short";
import { tmp002 } from "./tmp002-allowall-without-note";
import { tmp010 } from "./tmp010-cron-syntax";
import { tmp011 } from "./tmp011-namespace-reference";
import { tmp012 } from "./tmp012-activity-contract";
import { tmp013 } from "./tmp013-step-output-ref";
import { tmp014 } from "./tmp014-converge-rule-refusals";
import { stepOutput, when, eq, gt, run, report } from "@intentius/chant/op";
import type { ConvergeRule } from "@intentius/chant/op";
import type { ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";

// ── Helpers ─────────────────────────────────────────────────────────

function makeCtxFromOutput(output: string | { primary: string; files: Record<string, string> }): PostSynthContext {
  return {
    outputs: new Map([["temporal", output]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["temporal", output]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function makeEntity(entityType: string, props: Record<string, unknown>) {
  return {
    [DECLARABLE_MARKER]: true,
    entityType,
    lexicon: "temporal",
    kind: "resource",
    props,
    attributes: {},
  };
}

function makeCtxFromEntities(entities: Map<string, unknown>): PostSynthContext {
  return {
    outputs: new Map([["temporal", ""]]),
    entities: entities as Map<string, never>,
    buildResult: {
      outputs: new Map([["temporal", ""]]),
      entities: entities as Map<string, never>,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── TMP001: retention-too-short ──────────────────────────────────────

describe("TMP001: retention-too-short", () => {
  test("flags namespace with 1d retention", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "1d" })],
    ]));
    const diags = tmp001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TMP001");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("1d");
  });

  test("flags namespace with 48h retention", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "48h" })],
    ]));
    const diags = tmp001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TMP001");
  });

  test("passes with 3d retention (exactly at threshold)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "3d" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("passes with 7d retention", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "7d" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("passes when retention is unset (defaults to 7d)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("skips non-namespace entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["s", makeEntity("Temporal::Server", { mode: "dev" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("skips unrecognised retention format", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "1week" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });
});

// ── TMP002: allowall-without-note ────────────────────────────────────

describe("TMP002: allowall-without-note", () => {
  test("warns for AllowAll overlap without state.note", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "heavy-job",
        spec: { cronExpressions: ["0 * * * *"] },
        action: { workflowType: "heavyWorkflow", taskQueue: "heavy" },
        policies: { overlap: "AllowAll" },
      })],
    ]));
    const diags = tmp002.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TMP002");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when AllowAll has a note", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "heavy-job",
        spec: { cronExpressions: ["0 * * * *"] },
        action: { workflowType: "heavyWorkflow", taskQueue: "heavy" },
        policies: { overlap: "AllowAll" },
        state: { note: "Workflow is idempotent — concurrent runs are safe" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("passes for Skip overlap (no note needed)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "daily",
        spec: { cronExpressions: ["0 3 * * *"] },
        action: { workflowType: "dailyWorkflow", taskQueue: "daily" },
        policies: { overlap: "Skip" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("passes when no policies set", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "daily",
        spec: { cronExpressions: ["0 3 * * *"] },
        action: { workflowType: "dailyWorkflow", taskQueue: "daily" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("skips non-schedule entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default" })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });
});

// ── TMP010: cron-syntax ──────────────────────────────────────────────

describe("TMP010: cron-syntax", () => {
  test("warns for invalid cron with only 4 fields", () => {
    const content = `cronExpressions: ["0 3 * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    const diags = tmp010.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("TMP010");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes for valid 5-field cron", () => {
    const content = `cronExpressions: ["0 3 * * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("passes for valid 6-field cron (with seconds)", () => {
    const content = `cronExpressions: ["0 0 3 * * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("skips non-temporal lexicons", () => {
    const ctx: PostSynthContext = {
      outputs: new Map([["aws", `cronExpressions: ["invalid"]`]]),
      entities: new Map(),
      buildResult: {
        outputs: new Map([["aws", ""]]),
        entities: new Map(),
        warnings: [],
        errors: [],
        sourceFileCount: 1,
      },
    };
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("skips non-schedule files", () => {
    const content = `cronExpressions: ["bad"]`;
    const ctx = makeCtxFromOutput({
      primary: content,
      files: { "temporal-setup.sh": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("passes when output is plain string (no schedule files)", () => {
    const ctx = makeCtxFromOutput("# docker-compose.yml\nservices:\n  temporal:\n");
    expect(tmp010.check(ctx)).toHaveLength(0);
  });
});

// ── TMP011: namespace-reference ──────────────────────────────────────

describe("TMP011: namespace-reference", () => {
  test("errors when SearchAttribute references undeclared namespace", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword", namespace: "prod" })],
    ]));
    const diags = tmp011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TMP011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("prod");
  });

  test("passes when SearchAttribute namespace is declared", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "prod", retention: "30d" })],
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword", namespace: "prod" })],
    ]));
    expect(tmp011.check(ctx)).toHaveLength(0);
  });

  test("passes when SearchAttribute has no namespace (global)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword" })],
    ]));
    expect(tmp011.check(ctx)).toHaveLength(0);
  });

  test("flags each attribute with a missing namespace independently", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr1", makeEntity("Temporal::SearchAttribute", { name: "A", type: "Keyword", namespace: "missing1" })],
      ["attr2", makeEntity("Temporal::SearchAttribute", { name: "B", type: "Keyword", namespace: "missing2" })],
    ]));
    const diags = tmp011.check(ctx);
    expect(diags).toHaveLength(2);
  });
});

// ── TMP012: activity-contract (chant #1288 Stage 1) ─────────────────

function opEntity(name: string, steps: unknown[]) {
  return makeEntity("Temporal::Op", { name, overview: "test", phases: [{ name: "Phase", steps }] });
}

describe("TMP012: activity-contract", () => {
  test("passes when args match the registered contract exactly", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod", live: true } }])],
    ]));
    expect(tmp012.check(ctx)).toHaveLength(0);
  });

  test("skips a step whose fn has no registered contract", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "kubectlApply", args: { manifest: "dist/k8s.yaml", anything: "goes" } }])],
    ]));
    expect(tmp012.check(ctx)).toHaveLength(0);
  });

  test("errors on an unrecognized args key — lifecycleDiff's `env` typo'd as `environment`", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { environment: "prod" } }])],
    ]));
    const diags = tmp012.check(ctx);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.checkId === "TMP012" && d.severity === "error")).toBe(true);
    expect(diags.some((d) => d.message.includes("environment"))).toBe(true);
    expect(diags[0].message).toContain('Op "deploy"');
    expect(diags[0].entity).toBe("op");
  });

  test("errors on an outcomeAttribute.from path that doesn't exist on the declared return type", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, outcomeAttribute: { name: "Drift", from: "drifed" } },
      ])],
    ]));
    const diags = tmp012.check(ctx);
    expect(diags.some((d) => d.message.includes('outcomeAttribute.from "drifed"'))).toBe(true);
  });

  test("errors on an unknown profile", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "shellCmd", args: { cmd: "echo hi" }, profile: "longInfa" }])],
    ]));
    const diags = tmp012.check(ctx);
    expect(diags.some((d) => d.message.includes('unknown profile "longInfa"'))).toBe(true);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "30d" })],
    ]));
    expect(tmp012.check(ctx)).toHaveLength(0);
  });
});

// ── TMP013: step-output-ref (chant #1290) ────────────────────────────

function opEntityPhases(name: string, phases: Array<{ name: string; steps: unknown[]; parallel?: boolean }>) {
  return makeEntity("Temporal::Op", { name, overview: "test", phases });
}

describe("TMP013: step-output-ref", () => {
  test("passes for a valid same-phase reference to a preceding step", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        // "output" (string) into "contains" (string) — a type-compatible reference (#1950-3).
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "output") } },
      ])],
    ]));
    expect(tmp013.check(ctx)).toHaveLength(0);
  });

  test("errors on a reference to an unknown producer step id", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("nope", "x") } },
      ])],
    ]));
    const diags = tmp013.check(ctx);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.checkId === "TMP013" && d.severity === "error")).toBe(true);
    expect(diags.some((d) => d.message.includes('unknown step id "nope"'))).toBe(true);
    expect(diags[0].entity).toBe("op");
  });

  test("errors on a path that doesn't exist on the producer's declared return schema", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "notAField") } },
      ])],
    ]));
    const diags = tmp013.check(ctx);
    expect(diags.some((d) => d.message.includes('path "notAField"') && d.message.includes("does not exist"))).toBe(true);
  });

  test("errors on a reference to a later step (in a later phase)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntityPhases("reconcile", [
        { name: "Check", steps: [{ kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "drifted") } }] },
        { name: "Diff", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" }] },
      ])],
    ]));
    const diags = tmp013.check(ctx);
    expect(diags.some((d) => d.message.includes("later phase"))).toBe(true);
  });

  test("errors on a reference into a step whose fn has no registered contract", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "customUnregisteredActivity", args: {}, id: "custom" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("custom", "x") } },
      ])],
    ]));
    const diags = tmp013.check(ctx);
    expect(diags.some((d) => d.message.includes("no registered activity contract"))).toBe(true);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "30d" })],
    ]));
    expect(tmp013.check(ctx)).toHaveLength(0);
  });

  // ── cross-contract type compatibility (#1950-3) ──────────────────────────

  test("errors when a boolean-returning path feeds a string-typed arg", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "drifted") } },
      ])],
    ]));
    const diags = tmp013.check(ctx);
    expect(diags.some((d) => d.message.includes("type mismatch") && d.message.includes("boolean") && d.message.includes("string"))).toBe(true);
  });

  test("a matching type (string into string) passes", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "output") } },
      ])],
    ]));
    expect(tmp013.check(ctx)).toHaveLength(0);
  });
});

// ── TMP014: converge-rule-refusals (#1484) ───────────────────────────

function convergeOpEntity(
  name: string,
  rules: ConvergeRule<ConvergeSymptom>[],
  opts?: { dial?: "observe" | "reconcile" | "apply" },
) {
  return makeEntity("Temporal::Op", {
    name,
    overview: "test",
    searchAttributes: { Converge: "true", Env: "staging", Dial: opts?.dial ?? "observe" },
    phases: [
      { name: "Observe", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "staging" }, id: "diff" }] },
      { name: "Converge", steps: [{ kind: "activity", fn: "convergeTick", args: { rules } }] },
    ],
  });
}

function readOnlyOpEntity(name: string) {
  return opEntity(name, [{ kind: "activity", fn: "lifecycleDiff", args: { env: "staging" } }]);
}

function mutatingOpEntity(name: string) {
  return opEntity(name, [
    { kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "staging", output: "dist", deleteMode: "never" } },
  ]);
}

function destructiveOpEntity(name: string, opts?: { gated?: boolean }) {
  const steps: unknown[] = [
    { kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "staging", output: "dist", deleteMode: "gated" } },
  ];
  const phases = opts?.gated
    ? [
        { name: "Approve", steps: [{ kind: "gate", signalName: "approve-x" }] },
        { name: "Apply", steps },
      ]
    : [{ name: "Apply", steps }];
  return opEntityPhases(name, phases);
}

describe("TMP014: converge-rule-refusals", () => {
  test("passes a well-formed rule table dispatching a read-only op under observe", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("watch"), {
      id: "drift-watch",
      why: "Re-check drift with a read-only observation.",
    });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "observe" })],
      ["watch", readOnlyOpEntity("watch")],
    ]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });

  test("passes a report-only rule table with no dispatch at all", () => {
    const rule = when<ConvergeSymptom>(gt("adoptCount", 0), report("unowned resources present"), {
      id: "adopt-report",
      why: "Unowned resources are reported, never auto-claimed.",
    });
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [rule])]]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });

  test("errors when a rule has a blank why", () => {
    const badRule = {
      id: "no-why",
      when: { kind: "field-comparison", field: "status", op: "eq", value: "drifted" },
      then: { kind: "report", reason: "x" },
      why: "",
    } as unknown as ConvergeRule<ConvergeSymptom>;
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [badRule])]]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.checkId === "TMP014" && d.message.includes("must carry its why"))).toBe(true);
  });

  test("errors when a rule's predicate is malformed (outside the evaluable subset)", () => {
    const badRule = {
      id: "bad-predicate",
      when: { kind: "not-a-real-predicate-kind" },
      then: { kind: "report", reason: "x" },
      why: "some reason",
    } as unknown as ConvergeRule<ConvergeSymptom>;
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [badRule])]]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.message.includes("outside the evaluable subset"))).toBe(true);
  });

  test("errors when run() names an op that doesn't exist", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("does-not-exist"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [rule], { dial: "apply" })]]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.message.includes('unknown op "does-not-exist"'))).toBe(true);
  });

  test("errors when a mutating op is dispatched under an observe dial", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("apply-staging"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "observe" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.message.includes("mutating") && d.message.includes('dial "observe"'))).toBe(true);
  });

  test("passes a mutating dispatch under a reconcile dial", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("apply-staging"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "reconcile" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });

  test("errors when a destructive op is dispatched under a reconcile dial (never permitted outside apply)", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "reconcile" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: true })],
    ]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.message.includes("destructive") && d.message.includes('dial "reconcile"'))).toBe(true);
  });

  test("errors when a destructive op is dispatched under apply but has no gate", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: false })],
    ]));
    const diags = tmp014.check(ctx);
    expect(diags.some((d) => d.message.includes("no approval gate"))).toBe(true);
  });

  test("passes a destructive dispatch under apply when the target is gated", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: true })],
    ]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });

  test("ignores a Temporal::Op with no Converge search attribute", () => {
    const ctx = makeCtxFromEntities(new Map([["op", readOnlyOpEntity("op")]]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "30d" })],
    ]));
    expect(tmp014.check(ctx)).toHaveLength(0);
  });
});
