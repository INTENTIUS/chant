/**
 * #4988 on gitlab: the check job keeps a product's own files beside its
 * report, as `artifacts:paths` and `artifacts:reports`, such as sql-yodeler's
 * lint hook's code quality report. Without `artifacts` every file is the one
 * generated before.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { prCheckJob } from "@intentius/chant/components/pr-checks";
import { generateGitlabPipeline } from "./generate-pipeline";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";
import { gitlabProductCheckJobs } from "./product-check-jobs";

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const product = { words: yodel, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }] } };
const codequality = { reports: { codequality: "gl-code-quality-report.json" } };
const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
type Job = { artifacts?: Record<string, unknown> };

describe("the check job's own artifacts on gitlab (#4988)", () => {
  test("without artifacts, or with none named, the pipeline is unchanged", () => {
    const before = generateGitlabProductPlanPipeline("default", { ...product, checkJob: true }).yaml;
    expect(generateGitlabProductPlanPipeline("default", { ...product, checkJob: { artifacts: {} } }).yaml).toBe(before);
    expect(generateGitlabProductPlanPipeline("default", { ...product, checkJob: { artifacts: { paths: [], reports: {} } } }).yaml).toBe(before);
  });

  test("the product plan's check job keeps the code quality report beside .chant/check, when the check fails too", () => {
    const doc = parseYAML(generateGitlabProductPlanPipeline("default", { ...product, checkJob: { artifacts: { paths: ["out/"], ...codequality } } }).yaml) as Record<string, Job>;
    expect(doc.check!.artifacts).toEqual({ name: "chant-pr-check", when: "always", paths: [".chant/check", "out/"], reports: { codequality: "gl-code-quality-report.json" } });
  });

  test("a product's own pipeline gets the same check job", () => {
    const out = gitlabProductCheckJobs("default", { words: yodel, checkJob: { artifacts: { reports: { codequality: "gl-code-quality-report.json", junit: ["a.xml", "b.xml"] } } }, evidence: { runnerKeySecret: "K" } });
    const jobs = Object.fromEntries(out.entries) as Record<string, Job>;
    expect(jobs.check!.artifacts).toEqual({ name: "chant-pr-check", when: "always", paths: [".chant/check"], reports: { codequality: "gl-code-quality-report.json", junit: ["a.xml", "b.xml"] } });
    // The signing job reads the report directory alone.
    expect(JSON.stringify(jobs["check-evidence"])).not.toContain("gl-code-quality-report.json");
  });

  test("a workspace member's check job keeps them from the member's directory", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", member: { name: "app", dir: "app" }, prLoop: { checkJob: { artifacts: { paths: ["out"], ...codequality } } } } as never).yaml;
    const doc = parseYAML(yaml) as Record<string, Job>;
    expect(doc["app-check"]!.artifacts).toEqual({ name: "chant-pr-check", when: "always", paths: ["app/.chant/check", "app/out"], reports: { codequality: "app/gl-code-quality-report.json" } });
  });

  test("GitHub and Forgejo take none, and a path outside the checkout is refused", () => {
    for (const forge of ["github", "forgejo"] as const) {
      expect(() => prCheckJob(forge, { artifacts: codequality })).toThrow("the check job's artifacts are GitLab's artifacts:paths and artifacts:reports; on GitHub and Forgejo the check is the job's last step, so leave artifacts out there");
      // None named is none at all, on every forge.
      expect(prCheckJob(forge, { artifacts: {} })).not.toHaveProperty("artifacts");
    }
    expect(() => prCheckJob("gitlab", { artifacts: { paths: ["../secrets"] } })).toThrow('the check job\'s artifact path "../secrets" is not a relative path inside the checkout');
    expect(() => prCheckJob("gitlab", { artifacts: { paths: ["/etc"] } })).toThrow(/is not a relative path inside the checkout/);
    expect(() => prCheckJob("gitlab", { artifacts: { reports: { codequality: [] } } })).toThrow("the check job's codequality report [] is not a relative path inside the checkout");
    expect(() => prCheckJob("gitlab", { artifacts: { reports: { "Code Quality": "x.json" } } })).toThrow('the check job\'s artifact report "Code Quality" is not a GitLab report type');
    expect(() => prCheckJob("gitlab", { artifacts: { reports: { coverage_report: "cov.xml" } } })).toThrow(/coverage_report takes a format besides/);
  });
});
