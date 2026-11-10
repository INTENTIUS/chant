/**
 * #4935 and #4899 on forgejo: the GitHub generators' evidence, check, ref
 * gate and run record jobs, naming Forgejo, with `enable-openid-connect` on
 * the jobs that sign keyless. Without the options every file is unchanged.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
type Job = { "enable-openid-connect"?: boolean; needs?: string[]; steps: Array<{ name?: string; run?: string }> };
type Doc = { jobs: Record<string, Job> };
const loopYaml = (prLoop: Record<string, unknown>) => generateForgejoPipeline(ESTATE, { env: "prod", prLoop }).yaml;

describe("evidence, check and ref gate jobs on forgejo (#4935)", () => {
  test("without the options the workflow is unchanged", () => {
    expect(loopYaml({ evidence: undefined, checkJob: false })).toBe(loopYaml({}));
  });

  test("keyless, the note job and the check evidence job get enable-openid-connect, and the ref gate posts on forgejo", () => {
    const doc = parseYAML(loopYaml({ evidence: { identity: "oidc" }, checkJob: true, refGateStatus: true })) as Doc;
    expect(doc.jobs["plan-note"]!["enable-openid-connect"]).toBe(true);
    expect(doc.jobs["check-evidence"]!["enable-openid-connect"]).toBe(true);
    expect(doc.jobs.check!["enable-openid-connect"]).toBeUndefined();
    expect(doc.jobs.plan!["enable-openid-connect"]).toBeUndefined();
    expect(doc.jobs["ref-gate"]!.steps.at(-1)!.run!.trimEnd().split("\n").at(-1)).toBe('chant workspace ref-gate status --ref refs/heads/main --at "$HEAD_SHA" --base "$BASE_SHA"');
  });

  test("the product plan's record and check jobs", () => {
    const words = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
    const doc = parseYAML(generateForgejoProductPlanPipeline("default", { words, productPlan: { command: "yodel plan --pr-note {output}", record: true }, checkJob: true }).yaml) as Doc;
    expect(doc.jobs["plan-note"]!.steps.at(-1)!.run).toMatch(/--forge forgejo .*--record-run plan$/);
    expect(doc.jobs.check!.steps.at(-1)!.run!.trimEnd().split("\n").at(-1)).toBe('yodel chant ci check --base "$BASE_SHA"');
  });
});
