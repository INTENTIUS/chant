/**
 * OPS013 tests — ported from the temporal lexicon's TMP013
 * (chant #1290, moved to core by #2122).
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { stepOutput } from "../../../op";
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
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "30d" })],
    ]));
    expect(ops013.check(ctx)).toHaveLength(0);
  });

  test("ignores an entity whose entityType isn't Chant::Op", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["op", opEntity("reconcile", [
        { kind: "activity", fn: "httpCheck", args: { url: "http://x", contains: stepOutput("nope", "x") } },
      ], "Temporal::Op")],
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
