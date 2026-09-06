/**
 * OPS012 tests — ported from the temporal lexicon's TMP012
 * (chant #1288 Stage 1, moved to core by #2122).
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { ops012 } from "./ops012-activity-contract";

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

function opEntity(name: string, steps: unknown[], entityType = "Temporal::Op") {
  return makeEntity(entityType, { name, overview: "test", phases: [{ name: "Phase", steps }] });
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
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "30d" })],
    ]));
    expect(ops012.check(ctx)).toHaveLength(0);
  });

  // #2118 — the Op model's entity type is renaming from "Temporal::Op" to
  // "Chant::Op"; this check matches both until that migration lands.
  test("also matches the future \"Chant::Op\" entity type (#2118)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("deploy", [{ kind: "activity", fn: "lifecycleDiff", args: { environment: "prod" } }], "Chant::Op")],
    ]));
    const diags = ops012.check(ctx);
    expect(diags.some((d) => d.checkId === "OPS012")).toBe(true);
  });
});
