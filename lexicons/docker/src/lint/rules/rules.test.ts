import { describe, test, expect } from "vitest";
import { noLatestTagRule } from "./no-latest-tag";
import type { LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return {
    sourceFile,
    entities: [],
    filePath: "test.ts",
    lexicon: "docker",
  };
}

// ── DKRS001: no-latest-tag ────────────────────────────────────────

describe("DKRS001: no-latest-tag", () => {
  test("has correct id and severity", () => {
    expect(noLatestTagRule.id).toBe("DKRS001");
    expect(noLatestTagRule.severity).toBe("warning");
    expect(noLatestTagRule.category).toBe("correctness");
  });

  test("flags :latest tag", () => {
    const ctx = makeContext(`
      import { Service } from "@intentius/chant-lexicon-docker";
      export const api = new Service({ image: "nginx:latest" });
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("DKRS001");
    expect(diags[0].message).toContain("nginx:latest");
  });

  test("flags untagged image (no colon)", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("nginx");
  });

  test("does not flag explicitly versioned image", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx:1.25-alpine" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag digest-pinned image", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx@sha256:abc123" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag env() interpolation", () => {
    const ctx = makeContext(`
      const svc = { image: "\${APP_IMAGE:-myapp:latest}" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-image string properties", () => {
    const ctx = makeContext(`
      const svc = { restart: "latest" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
