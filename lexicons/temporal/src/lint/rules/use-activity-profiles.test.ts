import { describe, test, expect } from "vitest";
import { useActivityProfilesRule } from "./use-activity-profiles";
import type { LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile(
    "workflow.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return {
    sourceFile,
    entities: [],
    filePath: "workflow.ts",
    lexicon: "temporal",
  };
}

describe("TMP020: use-activity-profiles", () => {
  test("has correct id, severity, and category", () => {
    expect(useActivityProfilesRule.id).toBe("TMP020");
    expect(useActivityProfilesRule.severity).toBe("warning");
    expect(useActivityProfilesRule.category).toBe("style");
  });

  test("flags inline startToCloseTimeout", () => {
    const ctx = makeContext(`
      import { proxyActivities } from "@temporalio/workflow";
      const { applyInfra } = proxyActivities<typeof activities>({
        startToCloseTimeout: "5m",
      });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TMP020");
    expect(diags[0].message).toContain("TEMPORAL_ACTIVITY_PROFILES");
  });

  test("flags inline startToCloseTimeout alongside other inline fields", () => {
    const ctx = makeContext(`
      const { applyInfra } = proxyActivities<typeof activities>({
        startToCloseTimeout: "20m",
        heartbeatTimeout: "60s",
        retry: { maximumAttempts: 3 },
      });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag a named profile passed by reference", () => {
    const ctx = makeContext(`
      const { applyInfra } = proxyActivities<typeof activities>(
        TEMPORAL_ACTIVITY_PROFILES.longInfra,
      );
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag a named profile spread with overrides", () => {
    const ctx = makeContext(`
      const { applyInfra } = proxyActivities<typeof activities>({
        ...TEMPORAL_ACTIVITY_PROFILES.longInfra,
        heartbeatTimeout: "90s",
      });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag options with no startToCloseTimeout at all", () => {
    const ctx = makeContext(`
      const { applyInfra } = proxyActivities<typeof activities>({
        heartbeatTimeout: "60s",
      });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag unrelated calls named proxyActivities-like", () => {
    const ctx = makeContext(`
      const opts = notProxyActivities({ startToCloseTimeout: "5m" });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag files with no proxyActivities call at all", () => {
    const ctx = makeContext(`
      export const ns = new TemporalNamespace({ name: "default", retention: "7d" });
    `);
    const diags = useActivityProfilesRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
