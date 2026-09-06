/**
 * OPS013 tests — ported from a hosting lexicon's own TMP013
 * (chant #1290, moved to core by #2122).
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { stepOutput, activityContract, type ActivityContract } from "../../../op";
import { z } from "zod";
import { ops013 } from "./ops013-step-output-ref";

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

function opEntityPhases(name: string, phases: Array<{ name: string; steps: unknown[]; parallel?: boolean }>) {
  return makeEntity("Chant::Op", { name, overview: "test", phases });
}


// ── Cross-lexicon contracts (chant #2101) ────────────────────────────────
//
// An Op step may call an activity any configured lexicon contributes, and
// this check is core-owned, so it fires on every project that declares one.
// `ctx.activityContracts` is what `chant build`, `chant lint` and
// check-lexicon's example harness fill in from `loadActivityContracts`; the
// check merges it over its own static table.

/** Stand-in for what a lexicon (terraform) declares for its own activities. */
const foreignContracts = new Map<string, ActivityContract>([
  [
    "terraformPlan",
    activityContract(
      "terraformPlan",
      z.strictObject({ root: z.string(), planFile: z.string().optional() }),
      z.object({ planFile: z.string(), changed: z.boolean(), text: z.string() }),
    ),
  ],
  [
    "terraformApply",
    activityContract("terraformApply", z.strictObject({ root: z.string(), planFile: z.string().optional() })),
  ],
]);

function withContracts(ctx: PostSynthContext, contracts: ReadonlyMap<string, ActivityContract>): PostSynthContext {
  return { ...ctx, activityContracts: contracts };
}

describe("OPS013: step-output-ref", () => {
  test("passes for a valid same-phase reference to a preceding step", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        // "output" (string) into "contains" (string) — a type-compatible reference (#1950-3).
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "output") } },
      ])],
    ]));
    expect(ops013.check(ctx)).toHaveLength(0);
  });

  test("errors on a reference to an unknown producer step id", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("nope", "x") } },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.checkId === "OPS013" && d.severity === "error")).toBe(true);
    expect(diags.some((d) => d.message.includes('unknown step id "nope"'))).toBe(true);
    expect(diags[0].entity).toBe("op");
  });

  // No lexicon is configured, and no activity contract is registered for
  // this step's "fn" either — the dangling reference is still caught
  // structurally (chant #2122 acceptance: OPS013 fires on a project with no
  // lexicons configured).
  test("errors on an unknown producer step id with zero registered contracts", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "someActivity", args: { contains: stepOutput("nope", "x") } },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.some((d) => d.message.includes('unknown step id "nope"'))).toBe(true);
  });

  test("errors on a path that doesn't exist on the producer's declared return schema", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "notAField") } },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.some((d) => d.message.includes('path "notAField"') && d.message.includes("does not exist"))).toBe(true);
  });

  test("errors on a reference to a later step (in a later phase)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntityPhases("reconcile", [
        { name: "Check", steps: [{ kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "drifted") } }] },
        { name: "Diff", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" }] },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.some((d) => d.message.includes("later phase"))).toBe(true);
  });

  test("errors on a reference into a step whose fn has no registered contract", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "customUnregisteredActivity", args: {}, id: "custom" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("custom", "x") } },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.some((d) => d.message.includes("no registered activity contract"))).toBe(true);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["bucket", makeEntity("AWS::S3::Bucket", { name: "default" })],
    ]));
    expect(ops013.check(ctx)).toHaveLength(0);
  });

  test("ignores an entity whose entityType isn't Chant::Op", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("nope", "x") } },
      ], "Legacy::Op")],
    ]));
    expect(ops013.check(ctx)).toHaveLength(0);
  });

  // ── cross-contract type compatibility (#1950-3) ──────────────────────────

  test("errors when a boolean-returning path feeds a string-typed arg", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "drifted") } },
      ])],
    ]));
    const diags = ops013.check(ctx);
    expect(diags.some((d) => d.message.includes("type mismatch") && d.message.includes("boolean") && d.message.includes("string"))).toBe(true);
  });

  test("a matching type (string into string) passes", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "output") } },
      ])],
    ]));
    expect(ops013.check(ctx)).toHaveLength(0);
  });
});

describe("OPS013 reads a lexicon's activity contracts (#2101)", () => {
  const terraformOp = () =>
    makeCtxFromEntities(new Map([
      ["op", opEntity("app-apply", [
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "terraformApply", args: { root: "app", planFile: stepOutput("plan", "planFile") } },
      ])],
    ]));

  test("the foreign producer is flagged when the context carries no contracts — the pre-#2101 behaviour", () => {
    const diags = ops013.check(terraformOp());
    expect(diags.some((d) => d.message.includes("no registered activity contract"))).toBe(true);
  });

  test("it passes once the configured lexicon's contracts reach the check", () => {
    expect(ops013.check(withContracts(terraformOp(), foreignContracts))).toHaveLength(0);
  });

  test("a path the foreign contract's return schema does not declare is still caught", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("app-apply", [
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "terraformApply", args: { root: "app", planFile: stepOutput("plan", "planFyle") } },
      ])],
    ]));
    const diags = ops013.check(withContracts(ctx, foreignContracts));
    expect(diags.some((d) => d.message.includes('path "planFyle"') && d.message.includes("does not exist"))).toBe(true);
  });

  test("a cross-lexicon type mismatch is still caught", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("app-apply", [
        { kind: "activity", fn: "terraformPlan", args: { root: "app" }, id: "plan" },
        { kind: "activity", fn: "terraformApply", args: { root: "app", planFile: stepOutput("plan", "changed") } },
      ])],
    ]));
    const diags = ops013.check(withContracts(ctx, foreignContracts));
    expect(diags.some((d) => d.message.includes("type mismatch"))).toBe(true);
  });

  test("core's own contracts survive the merge", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, id: "diff" },
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("diff", "notAField") } },
      ])],
    ]));
    const diags = ops013.check(withContracts(ctx, foreignContracts));
    expect(diags.some((d) => d.message.includes('path "notAField"'))).toBe(true);
  });
});
