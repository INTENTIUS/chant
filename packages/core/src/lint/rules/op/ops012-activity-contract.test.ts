/**
 * OPS012 tests — ported from a hosting lexicon's own TMP012
 * (chant #1288 Stage 1, moved to core by #2122).
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { ops012 } from "./ops012-activity-contract";
import { activityContract, type ActivityContract } from "../../../op";
import { z } from "zod";

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

describe("OPS012: activity-contract", () => {
  test("passes when args match the registered contract exactly", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod", live: true } }])],
    ]));
    expect(ops012.check(ctx)).toHaveLength(0);
  });

  test("skips a step whose fn has no registered contract", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "kubectlApply", args: { manifest: "dist/k8s.yaml", anything: "goes" } }])],
    ]));
    expect(ops012.check(ctx)).toHaveLength(0);
  });

  test("errors on an unrecognized args key — lifecycleDiff's `env` typo'd as `environment`", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { environment: "prod" } }])],
    ]));
    const diags = ops012.check(ctx);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.checkId === "OPS012" && d.severity === "error")).toBe(true);
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
    const diags = ops012.check(ctx);
    expect(diags.some((d) => d.message.includes('outcomeAttribute.from "drifed"'))).toBe(true);
  });

  test("errors on an unknown profile", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "shellCmd", args: { cmd: "echo hi" }, profile: "longInfa" }])],
    ]));
    const diags = ops012.check(ctx);
    expect(diags.some((d) => d.message.includes('unknown profile "longInfa"'))).toBe(true);
  });

  test("ignores non-Op entities", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["bucket", makeEntity("AWS::S3::Bucket", { name: "default" })],
    ]));
    expect(ops012.check(ctx)).toHaveLength(0);
  });

  test("ignores an entity whose entityType isn't Chant::Op", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { environment: "prod" } }], "Legacy::Op")],
    ]));
    expect(ops012.check(ctx)).toHaveLength(0);
  });
});

describe("OPS012 reads a lexicon's activity contracts (#2101)", () => {
  const typoedStep = () =>
    makeCtxFromEntities(new Map([
      ["op", opEntity("app-plan", [{ kind: "activity", fn: "terraformPlan", args: { root: "app", planfile: "x" } }])],
    ]));

  test("a step calling an unknown activity is skipped when the context carries no contracts", () => {
    expect(ops012.check(typoedStep())).toHaveLength(0);
  });

  test("the same step's misspelled arg is an error once the lexicon's contracts reach the check", () => {
    const diags = ops012.check(withContracts(typoedStep(), foreignContracts));
    expect(diags.some((d) => d.message.includes("planfile"))).toBe(true);
    expect(diags.every((d) => d.checkId === "OPS012" && d.severity === "error")).toBe(true);
  });

  test("a well-formed foreign step passes", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("app-plan", [{ kind: "activity", fn: "terraformPlan", args: { root: "app", planFile: "x" } }])],
    ]));
    expect(ops012.check(withContracts(ctx, foreignContracts))).toHaveLength(0);
  });

  test("core's own contracts survive the merge", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { environment: "prod" } }])],
    ]));
    const diags = ops012.check(withContracts(ctx, foreignContracts));
    expect(diags.some((d) => d.message.includes("environment"))).toBe(true);
  });
});
