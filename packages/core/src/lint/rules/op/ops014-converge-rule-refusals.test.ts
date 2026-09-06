/**
 * OPS014 tests — ported from a hosting lexicon's own TMP014
 * (#1484, moved to core by #2122).
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { when, eq, gt, allOf, run, report } from "../../../op";
import type { ConvergeRule } from "../../../op";
import type { ConvergeSymptom } from "../../../lifecycle/symptoms";
import { ops014 } from "./ops014-converge-rule-refusals";

function makeEntity(entityType: string, props: Record<string, unknown>) {
  return {
    [DECLARABLE_MARKER]: true,
    entityType,
    lexicon: "chant",
    kind: "resource",
    props,
    attributes: {},
  };
}

function makeCtxFromEntities(entities: Map<string, unknown>): PostSynthContext {
  return {
    outputs: new Map([["chant", ""]]),
    entities: entities as Map<string, never>,
    buildResult: {
      outputs: new Map([["chant", ""]]),
      entities: entities as Map<string, never>,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function opEntity(name: string, steps: unknown[], entityType = "Chant::Op") {
  return makeEntity(entityType, { name, overview: "test", phases: [{ name: "Phase", steps }] });
}

function convergeOpEntity(
  name: string,
  rules: ConvergeRule<ConvergeSymptom>[],
  opts?: { dial?: "observe" | "reconcile" | "apply"; entityType?: string },
) {
  return makeEntity(opts?.entityType ?? "Chant::Op", {
    name,
    overview: "test",
    labels: { Converge: "true", Env: "staging", Dial: opts?.dial ?? "observe" },
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
  return makeEntity("Chant::Op", { name, overview: "test", phases });
}

describe("OPS014: converge-rule-refusals", () => {
  test("passes a well-formed rule table dispatching a read-only op under observe", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("watch"), {
      id: "drift-watch",
      why: "Re-check drift with a read-only observation.",
    });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "observe" })],
      ["watch", readOnlyOpEntity("watch")],
    ]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("passes a report-only rule table with no dispatch at all", () => {
    const rule = when<ConvergeSymptom>(gt("adoptCount", 0), report("unowned resources present"), {
      id: "adopt-report",
      why: "Unowned resources are reported, never auto-claimed.",
    });
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [rule])]]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("errors when a rule has a blank why", () => {
    const badRule = {
      id: "no-why",
      when: { kind: "field-comparison", field: "status", op: "eq", value: "drifted" },
      then: { kind: "report", reason: "x" },
      why: "",
    } as unknown as ConvergeRule<ConvergeSymptom>;
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [badRule])]]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.checkId === "OPS014" && d.message.includes("must carry its why"))).toBe(true);
  });

  test("errors when a rule's predicate is malformed (outside the evaluable subset)", () => {
    const badRule = {
      id: "bad-predicate",
      when: { kind: "not-a-real-predicate-kind" },
      then: { kind: "report", reason: "x" },
      why: "some reason",
    } as unknown as ConvergeRule<ConvergeSymptom>;
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [badRule])]]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("outside the evaluable subset"))).toBe(true);
  });

  test("errors when run() names an op that doesn't exist", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("does-not-exist"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [rule], { dial: "apply" })]]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes('unknown op "does-not-exist"'))).toBe(true);
  });

  test("errors when a mutating op is dispatched under an observe dial", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("apply-staging"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "observe" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("mutating") && d.message.includes('dial "observe"'))).toBe(true);
  });

  // Finding A (#1954 pre-merge review): issue #1484's own Autonomy table
  // gives `reconcile` × mutating "open PR", not "run directly" — v1 doesn't
  // build the PR-opening channel, so this is refused rather than silently
  // escalated to match `apply`'s authority.
  test("errors when a mutating op is dispatched under a reconcile dial — reconcile's table answer is \"open PR\", not implemented in v1", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("apply-staging"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "reconcile" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("mutating") && d.message.includes('dial "reconcile"') && d.message.includes("open PR"))).toBe(true);
  });

  test("passes a mutating dispatch under an apply dial", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("apply-staging"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  // Finding B (#1954 pre-merge review): a destructive dispatch target is
  // refused under every dial, `apply` included — a converge tick is
  // unattended, so a destructive target needs a human's approval before
  // it's attempted, not a gate the tick consults after already committing to
  // running it.
  test("errors when a destructive op is dispatched under a reconcile dial", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "reconcile" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: true })],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("destructive") && d.message.includes("refused in v1"))).toBe(true);
  });

  test("errors when a destructive op is dispatched under apply and has no gate", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: false })],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("destructive") && d.message.includes("refused in v1"))).toBe(true);
  });

  test("errors when a destructive op is dispatched under apply even when the target is gated — approval must come before dispatch, not after", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("prune-staging"), { id: "drift-prune", why: "Prune drifted resources." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["prune-staging", destructiveOpEntity("prune-staging", { gated: true })],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes("destructive") && d.message.includes("refused in v1"))).toBe(true);
  });

  // Finding C (#1954 pre-merge review): adopt safety — "an unowned resource
  // is reported, never auto-claimed" — is enforced, not just documented.
  test("errors when a rule reads adoptCount and dispatches a mutating op", () => {
    const rule = when<ConvergeSymptom>(gt("adoptCount", 0), run("apply-staging"), { id: "adopt-apply", why: "test" });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes('reads "adoptCount"') && d.message.includes("mutating"))).toBe(true);
  });

  test("errors when adoptCount is read inside a nested allOf/anyOf predicate that dispatches a mutating op", () => {
    const rule = when<ConvergeSymptom>(
      allOf(eq("status", "drifted"), gt("adoptCount", 0)),
      run("apply-staging"),
      { id: "nested-adopt-apply", why: "test" },
    );
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["apply-staging", mutatingOpEntity("apply-staging")],
    ]));
    const diags = ops014.check(ctx);
    expect(diags.some((d) => d.message.includes('reads "adoptCount"'))).toBe(true);
  });

  test("passes a rule that reads adoptCount and dispatches a read-only op", () => {
    const rule = when<ConvergeSymptom>(gt("adoptCount", 0), run("watch"), { id: "adopt-watch", why: "test" });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply" })],
      ["watch", readOnlyOpEntity("watch")],
    ]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("passes a rule that reads adoptCount and only reports (no dispatch at all)", () => {
    const rule = when<ConvergeSymptom>(gt("adoptCount", 0), report("unowned resources present"), { id: "adopt-report", why: "test" });
    const ctx = makeCtxFromEntities(new Map([["converge", convergeOpEntity("converge", [rule], { dial: "apply" })]]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("ignores an Op with no Converge search attribute", () => {
    const ctx = makeCtxFromEntities(new Map([["op", readOnlyOpEntity("op")]]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["bucket", makeEntity("AWS::S3::Bucket", { name: "default" })],
    ]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });

  test("ignores an entity whose entityType isn't Chant::Op", () => {
    const rule = when<ConvergeSymptom>(eq("status", "drifted"), run("does-not-exist"), { id: "drift-apply", why: "Re-apply on drift." });
    const ctx = makeCtxFromEntities(new Map([
      ["converge", convergeOpEntity("converge", [rule], { dial: "apply", entityType: "Legacy::Op" })],
    ]));
    expect(ops014.check(ctx)).toHaveLength(0);
  });
});
