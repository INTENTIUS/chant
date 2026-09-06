import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { planBeforeApplyRule } from "./plan-before-apply";

function createContext(code: string, fileName = "infra.op.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("TF101: plan-before-apply", () => {
  test("flags a literal plan path", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan({ root: "app" });
        const apply = terraformApply({ planFile: "/tmp/plan.out" });
      `),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TF101");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("literal path");
  });

  test("flags a template literal plan path", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan({ root: "app" });
        const dir = "/tmp";
        const apply = terraformApply({ planFile: \`\${dir}/plan.out\` });
      `),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("literal path");
  });

  test("flags a reference to a non-plan step", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const notAPlan = someOtherStep({ root: "app" });
        const apply = terraformApply({ planFile: stepOutput(notAPlan, "planFile") });
      `),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("not bound to a `terraformPlan");
  });

  test("passes stepOutput(plan, \"planFile\")", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan({ root: "app" });
        const apply = terraformApply({ planFile: stepOutput(plan, "planFile") });
      `),
    );
    expect(diags).toHaveLength(0);
  });

  test("passes plan.out.planFile", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan({ root: "app" });
        const apply = terraformApply({ planFile: plan.out.planFile });
      `),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag when the target cannot be resolved statically", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const apply = terraformApply({ planFile: plan.out.planFile });
      `),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag terraformApply calls with no planFile property", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const apply = terraformApply({ root: "app" });
      `),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag planFile-shaped keys outside terraformApply", () => {
    const diags = planBeforeApplyRule.check(
      createContext(`
        const config = { planFile: "/tmp/plan.out" };
      `),
    );
    expect(diags).toHaveLength(0);
  });
});
