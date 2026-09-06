import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { planBeforeApplyRule } from "./plan-before-apply";
import { loadRuleFixture } from "./fixtures/load";

function createContext(code: string, fileName = "infra.op.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("TF101: plan-before-apply", () => {
  test("flags a literal plan path", () => {
    const diags = planBeforeApplyRule.check(loadRuleFixture("TF101", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TF101");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("literal path");
  });

  test("passes a step-output reference to the preceding plan (fixtures/TF101/negative.op.ts)", () => {
    const diags = planBeforeApplyRule.check(loadRuleFixture("TF101", "negative"));
    expect(diags).toHaveLength(0);
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

  test("checks the options object when it follows a positional root argument (k3s-shaped builder)", () => {
    const flagged = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan("app", { planFile: "plan.out" });
        const apply = terraformApply("app", { planFile: "/tmp/plan.out" });
      `),
    );
    expect(flagged).toHaveLength(1);
    const passing = planBeforeApplyRule.check(
      createContext(`
        const plan = terraformPlan("app", { id: "plan" });
        const apply = terraformApply("app", { planFile: plan.out.planFile });
      `),
    );
    expect(passing).toHaveLength(0);
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

describe("TF101: mode awareness against chant.config.json (#2106)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A throwaway project with one `terraform.roots` entry, live or stock. */
  function project(opts: { binary?: string; live?: boolean }): string {
    const dir = mkdtempSync(join(tmpdir(), "chant-tf101-mode-"));
    dirs.push(dir);
    mkdirSync(join(dir, "root"), { recursive: true });
    writeFileSync(
      join(dir, "root", "main.tf"),
      opts.live
        ? ["terraform {", "  live {", '    estate = "fixture-estate"', "  }", "}", ""].join("\n")
        : 'resource "null_resource" "x" {}\n',
    );
    writeFileSync(
      join(dir, "chant.config.json"),
      JSON.stringify({ terraform: { binary: opts.binary ?? "terraform", roots: { app: { dir: "./root" } } } }),
    );
    return dir;
  }

  /** A `LintContext` whose file lives inside `project`, so the rule's upward walk finds its `chant.config.json`. */
  function contextIn(project: string, code: string): LintContext {
    const filePath = join(project, "ops", "app.op.ts");
    const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
    return { sourceFile, entities: [], filePath };
  }

  test("does not fire on a terraformApply call over a live root, even with a literal planFile", () => {
    const dir = project({ binary: "choudoufu", live: true });
    const diags = planBeforeApplyRule.check(
      contextIn(
        dir,
        `
          const apply = terraformApply("app", { planFile: "/tmp/plan.out" });
        `,
      ),
    );
    expect(diags).toHaveLength(0);
  });

  test("still fires on a terraformApply call over a stock root in the same shape", () => {
    const dir = project({ binary: "terraform", live: false });
    const diags = planBeforeApplyRule.check(
      contextIn(
        dir,
        `
          const apply = terraformApply("app", { planFile: "/tmp/plan.out" });
        `,
      ),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("literal path");
  });

  test("still fires when the root is choudoufu but declares no estate (stock branch)", () => {
    const dir = project({ binary: "choudoufu", live: false });
    const diags = planBeforeApplyRule.check(
      contextIn(
        dir,
        `
          const apply = terraformApply("app", { planFile: "/tmp/plan.out" });
        `,
      ),
    );
    expect(diags).toHaveLength(1);
  });

  test("root name via a root: property (object-literal-only call form) resolves the same way", () => {
    const dir = project({ binary: "choudoufu", live: true });
    const diags = planBeforeApplyRule.check(
      contextIn(
        dir,
        `
          const apply = terraformApply({ root: "app", planFile: "/tmp/plan.out" });
        `,
      ),
    );
    expect(diags).toHaveLength(0);
  });
});
