/**
 * #4935 and #4899 on gitlab: the merge request loop's plan evidence job, the
 * check, check evidence and ref gate jobs, and the product plan's run record
 * kept by `pr-post --open --record-run`. Without the options every file is
 * the one generated before.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
type Job = { stage: string; rules: Array<{ if: string }>; needs?: Array<{ job: string }>; variables?: Record<string, string>; id_tokens?: unknown; script: string[]; artifacts?: { paths: string[] } };
type Doc = Record<string, unknown> & { stages: string[] };
const loopYaml = (prLoop: Record<string, unknown>) => generateGitlabPipeline(ESTATE, { env: "prod", prLoop }).yaml;

describe("the merge request loop's evidence, check and ref gate jobs on gitlab (#4935)", () => {
  test("without the options the pipeline is unchanged", () => {
    expect(loopYaml({ evidence: undefined, checkJob: false, refGateStatus: false })).toBe(loopYaml({}));
    expect(loopYaml({})).not.toContain("ci evidence");
  });

  test("with evidence a plan-evidence job signs plan and policy from the plan job's artifact", () => {
    const doc = parseYAML(loopYaml({ evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" } })) as Doc;
    expect(doc.stages.slice(0, 3)).toEqual(["plan", "evidence", "plan-note"]);
    const ev = doc["plan-evidence"] as Job;
    expect(ev.needs).toEqual([{ job: "plan", artifacts: true }]);
    expect(ev.variables).toEqual({ CHANT_RUNNER_KEY: "$CHANT_RUNNER_KEY_PEM" });
    expect(ev.script.at(-1)).toBe('chant ci evidence sign --from-report .chant/pr --result success --at "$CI_COMMIT_SHA" --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA"');
  });

  test("keyless, the evidence job asks for the signing token", () => {
    const ev = (parseYAML(loopYaml({ evidence: { identity: "oidc" } })) as Doc)["plan-evidence"] as Job;
    expect(ev.id_tokens).toEqual({ CHANT_ID_TOKEN_SIGSTORE: { aud: "sigstore" } });
  });

  test("the check job drops the tokens and the key, the evidence job signs the hooks, the ref gate posts from the notes pipeline", () => {
    const doc = parseYAML(loopYaml({ checkJob: true, refGateStatus: true, evidence: { runnerKeySecret: "K" } })) as Doc;
    const check = doc.check as Job;
    expect(check.stage).toBe("plan");
    expect(check.script[0]).toMatch(/^unset .*CI_JOB_TOKEN/);
    expect(check.script[1]).toBe("unset K");
    expect(check.script.at(-1)).toBe('chant ci check --base "$BASE_SHA"');
    expect(check.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA" });
    expect(check.artifacts!.paths).toEqual([".chant/check"]);
    const ev = doc["check-evidence"] as Job;
    expect(ev.needs).toEqual([{ job: "check", artifacts: true }]);
    expect(ev.script.at(-1)).toContain("ci evidence sign --from-report .chant/check");
    const gate = doc["ref-gate"] as Job;
    expect(doc.stages.indexOf("ref-gate")).toBe(doc.stages.indexOf("plan-note") + 1);
    expect(gate.rules[0]!.if).toContain("CHANT_PLAN_NOTES");
    expect(gate.script.at(-1)).toBe('chant workspace ref-gate status --open --ref "refs/heads/$CI_COMMIT_BRANCH" --base "$CI_COMMIT_SHA"');
  });
});

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const product = { words: yodel, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }] } };

describe("the product plan's record and check jobs on gitlab (#4899, #4935)", () => {
  test("without the options the pipeline is unchanged", () => {
    expect(generateGitlabProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, record: false } }).yaml).toBe(generateGitlabProductPlanPipeline("default", product).yaml);
  });

  test("record: the plan job writes the record and the note job's pr-post --open keeps it", () => {
    const doc = parseYAML(generateGitlabProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, record: true } }).yaml) as Doc;
    const plan = doc["staging-plan"] as Job;
    expect(plan.script.some((l) => l.includes("node -e") && l.includes("CHANT_PLAN_EXIT"))).toBe(true);
    expect(JSON.parse(plan.variables!.CHANT_PLAN_RECORD!).labels.Target).toBe("staging");
    expect((doc["staging-plan-note"] as Job).script.at(-1)).toMatch(/pr-post --open .*--record-run staging-plan$/);
  });

  test("checkJob and refGateStatus render beside the product's plans", () => {
    const doc = parseYAML(generateGitlabProductPlanPipeline("default", { ...product, checkJob: true, refGateStatus: true }).yaml) as Doc;
    expect((doc.check as Job).script.at(-1)).toBe('yodel chant ci check --base "$BASE_SHA"');
    expect(doc.stages).toContain("ref-gate");
    expect(doc["check-evidence"]).toBeUndefined();
  });
});
