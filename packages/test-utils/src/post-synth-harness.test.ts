import { describe, test, expect } from "bun:test";
import {
  makePostSynthCtx,
  makePostSynthCtxFromFiles,
  makePostSynthCtxFromJSON,
  runCheck,
  expectNoDiagnostics,
  expectDiagnostic,
} from "./post-synth-harness";
import type { PostSynthCheck, PostSynthDiagnostic } from "../../core/src/lint/post-synth";

const passingCheck: PostSynthCheck = {
  id: "TEST001",
  description: "Always passes",
  check: () => [],
};

const failingCheck: PostSynthCheck = {
  id: "TEST002",
  description: "Always fails",
  check: (): PostSynthDiagnostic[] => [
    { checkId: "TEST002", severity: "error", message: "Something is wrong" },
  ],
};

describe("makePostSynthCtx", () => {
  test("creates context from string output", () => {
    const ctx = makePostSynthCtx("k8s", "apiVersion: v1\nkind: Pod");
    expect(ctx.outputs.get("k8s")).toBe("apiVersion: v1\nkind: Pod");
    expect(ctx.entities.size).toBe(0);
    expect(ctx.buildResult.sourceFileCount).toBe(1);
  });

  test("creates context with entities", () => {
    const entities = new Map();
    const ctx = makePostSynthCtx("gcp", "resources:", entities);
    expect(ctx.entities).toBe(entities);
    expect(ctx.buildResult.entities).toBe(entities);
  });
});

describe("makePostSynthCtxFromFiles", () => {
  test("creates context from multi-file output", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test",
      "values.yaml": "replicas: 1",
    };
    const ctx = makePostSynthCtxFromFiles("helm", files);
    const output = ctx.outputs.get("helm");
    expect(typeof output).toBe("object");
    expect((output as any).files["Chart.yaml"]).toContain("apiVersion: v2");
    expect((output as any).files["values.yaml"]).toContain("replicas: 1");
  });

  test("uses first file as primary when not specified", () => {
    const ctx = makePostSynthCtxFromFiles("helm", { "Chart.yaml": "data" });
    expect((ctx.outputs.get("helm") as any).primary).toBe("data");
  });

  test("uses custom primary", () => {
    const ctx = makePostSynthCtxFromFiles("helm", { "a.yaml": "a" }, "custom primary");
    expect((ctx.outputs.get("helm") as any).primary).toBe("custom primary");
  });
});

describe("makePostSynthCtxFromJSON", () => {
  test("creates context from JSON object", () => {
    const ctx = makePostSynthCtxFromJSON("aws", { Resources: { MyBucket: {} } });
    const output = ctx.outputs.get("aws") as string;
    expect(JSON.parse(output)).toEqual({ Resources: { MyBucket: {} } });
  });
});

describe("runCheck", () => {
  test("returns diagnostics from check", () => {
    const ctx = makePostSynthCtx("test", "output");
    const diags = runCheck(failingCheck, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TEST002");
  });

  test("returns empty array for passing check", () => {
    const ctx = makePostSynthCtx("test", "output");
    expect(runCheck(passingCheck, ctx)).toHaveLength(0);
  });
});

describe("expectNoDiagnostics", () => {
  test("passes for clean check", () => {
    const ctx = makePostSynthCtx("test", "output");
    expectNoDiagnostics(passingCheck, ctx);
  });

  test("throws for failing check", () => {
    const ctx = makePostSynthCtx("test", "output");
    expect(() => expectNoDiagnostics(failingCheck, ctx)).toThrow("Expected no diagnostics");
  });
});

describe("expectDiagnostic", () => {
  test("passes when diagnostic matches checkId", () => {
    const ctx = makePostSynthCtx("test", "output");
    const diags = expectDiagnostic(failingCheck, ctx, { checkId: "TEST002" });
    expect(diags).toHaveLength(1);
  });

  test("passes when diagnostic matches severity", () => {
    const ctx = makePostSynthCtx("test", "output");
    expectDiagnostic(failingCheck, ctx, { severity: "error" });
  });

  test("passes when diagnostic matches messageContains", () => {
    const ctx = makePostSynthCtx("test", "output");
    expectDiagnostic(failingCheck, ctx, { messageContains: "wrong" });
  });

  test("throws when no diagnostics produced", () => {
    const ctx = makePostSynthCtx("test", "output");
    expect(() => expectDiagnostic(passingCheck, ctx, {})).toThrow("Expected diagnostics");
  });

  test("throws when checkId does not match", () => {
    const ctx = makePostSynthCtx("test", "output");
    expect(() => expectDiagnostic(failingCheck, ctx, { checkId: "WRONG" })).toThrow("WRONG");
  });
});
