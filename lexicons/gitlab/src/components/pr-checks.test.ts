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
type Job = { stage: string; rules: Array<{ if: string; when?: string }>; needs?: Array<{ job: string }>; variables?: Record<string, string>; id_tokens?: unknown; environment?: unknown; script: string[]; artifacts?: { paths: string[] } };
type Doc = Record<string, unknown> & { stages: string[] };
const loopYaml = (prLoop: Record<string, unknown>) => generateGitlabPipeline(ESTATE, { env: "prod", prLoop }).yaml;

describe("the merge request loop's evidence, check and ref gate jobs on gitlab (#4935)", () => {
  test("without the options the pipeline is unchanged", () => {
    expect(loopYaml({ evidence: undefined, checkJob: false, refGateStatus: false })).toBe(loopYaml({}));
    expect(loopYaml({})).not.toContain("ci evidence");
  });

  test("with evidence a plan-evidence job of the plan notes pipeline signs every open merge request's plan, and the note reads it (#4914)", () => {
    const doc = parseYAML(loopYaml({ evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" } })) as Doc;
    expect(doc.stages.slice(0, 3)).toEqual(["plan", "evidence", "plan-note"]);
    const ev = doc["plan-evidence"] as Job;
    // The target branch's pipeline, never the merge request's, and the environment the key's variable is scoped to.
    expect(ev.rules).toEqual([{ if: (doc["plan-note"] as Job).rules[0]!.if }]);
    expect(ev.rules[0]!.if).toContain("CHANT_PLAN_NOTES");
    expect(ev.environment).toEqual({ name: "chant-evidence", action: "access" });
    expect(ev.needs).toBeUndefined();
    expect(ev.variables).toEqual({ CHANT_RUNNER_KEY: "$CHANT_RUNNER_KEY_PEM" });
    expect(ev.script.at(-1)).toBe('chant ci evidence sign --open --job plan --from-report .chant/pr --base "$CI_COMMIT_SHA" --output .chant/evidence/plan');
    expect(ev.artifacts!.paths).toEqual([".chant/evidence/plan"]);
    const note = doc["plan-note"] as Job;
    expect(note.script.at(-1)).toMatch(/pr-post --open .* --evidence-dir \.chant\/evidence\/plan$/);
    expect(note.rules[0]).toMatchObject({ when: "always" });
  });

  test("with evidence no job of the merge request pipeline names the key or the signing environment (#4914)", () => {
    for (const evidence of [{ runnerKeySecret: "CHANT_RUNNER_KEY_PEM" }, { identity: "oidc" }]) {
      const doc = parseYAML(loopYaml({ evidence, checkJob: true })) as Doc;
      const mergeRequest = Object.entries(doc).filter(([name, j]) => name !== "workflow" && (j as Job | undefined)?.rules?.some((r) => r.if.includes("merge_request_event")));
      expect(mergeRequest.map(([name]) => name).sort()).toEqual(["check", "plan"]);
      for (const [, job] of mergeRequest) {
        expect(JSON.stringify((job as Job).variables ?? {})).not.toMatch(/CHANT_RUNNER_KEY|CHANT_RUNNER_IDENTITY/);
        expect((job as Job).environment).toBeUndefined();
        expect((job as Job).id_tokens).toBeUndefined();
      }
    }
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
    expect(ev.needs).toBeUndefined();
    expect(ev.rules[0]!.if).toContain("CHANT_PLAN_NOTES");
    expect(ev.environment).toEqual({ name: "chant-evidence", action: "access" });
    expect(ev.script.at(-1)).toBe('chant ci evidence sign --open --job check --from-report .chant/check --base "$CI_COMMIT_SHA" --output .chant/evidence/check');
    const gate = doc["ref-gate"] as Job;
    expect(doc.stages.indexOf("ref-gate")).toBe(doc.stages.indexOf("plan-note") + 1);
    expect(gate.rules[0]!.if).toContain("CHANT_PLAN_NOTES");
    expect(gate.script.at(-1)).toBe('chant workspace ref-gate status --open --ref "refs/heads/$CI_COMMIT_BRANCH" --base "$CI_COMMIT_SHA"');
  });
});

describe("a workspace member's merge request pipeline on gitlab (#4964)", () => {
  const member = { name: "app", dir: "app" };
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", member, prLoop: { checkJob: true, refGateStatus: true, evidence: { runnerKeySecret: "K" } } } as never).yaml) as Doc;

  test("the jobs take the member's name, and the plan and policy are signed under it", () => {
    const ev = doc["app-plan-evidence"] as Job;
    expect(ev.environment).toEqual({ name: "chant-evidence", action: "access" });
    expect(ev.script).toEqual(["cd app", 'chant ci evidence sign --open --job app-plan --from-report app/.chant/pr --member app --base "$CI_COMMIT_SHA" --output .chant/evidence/app-plan']);
    // Written in the member's directory, and kept from there, where the note job reads it.
    expect(ev.artifacts!.paths).toEqual(["app/.chant/evidence/app-plan"]);
    expect((doc["app-plan-note"] as Job).script).toContain("cd app");
    expect((doc["app-plan-note"] as Job).script.at(-1)).toMatch(/--evidence-dir \.chant\/evidence\/app-plan$/);
  });

  test("the check runs in the member's directory, and the ref gate posts from the notes pipeline", () => {
    const check = doc["app-check"] as Job;
    expect(check.script).toContain("cd app");
    expect(check.artifacts!.paths).toEqual(["app/.chant/check"]);
    expect((doc["app-check-evidence"] as Job).script.at(-1)).toBe('chant ci evidence sign --open --job app-check --from-report app/.chant/check --base "$CI_COMMIT_SHA" --output .chant/evidence/app-check');
    expect((doc["app-ref-gate"] as Job).script.at(-1)).toBe('chant workspace ref-gate status --open --ref "refs/heads/$CI_COMMIT_BRANCH" --base "$CI_COMMIT_SHA"');
    for (const name of ["check", "check-evidence", "ref-gate", "plan-evidence"]) expect(doc[name], name).toBeUndefined();
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

  test("with evidence the signing jobs are the plan notes pipeline's, and each note job reads its plan's evidence (#4914)", () => {
    const doc = parseYAML(generateGitlabProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, forks: "skip" }, checkJob: true, evidence: { runnerKeySecret: "K" } }).yaml) as Doc;
    const ev = doc["staging-plan-evidence"] as Job;
    expect(ev.rules[0]!.if).toContain("CHANT_PLAN_NOTES");
    expect(ev.environment).toEqual({ name: "chant-evidence", action: "access" });
    // forks: "skip" plans no fork's merge request, and signs none either.
    expect(ev.script.at(-1)).toBe('yodel chant ci evidence sign --open --job staging-plan --from-report .chant/pr --base "$CI_COMMIT_SHA" --output .chant/evidence/staging-plan --no-forks');
    expect((doc["check-evidence"] as Job).script.at(-1)).toMatch(/--job check .* --no-forks$/);
    expect((doc["staging-plan-note"] as Job).script.at(-1)).toMatch(/pr-post --open .*--member staging.* --evidence-dir \.chant\/evidence\/staging-plan$/);
    for (const name of ["staging-plan", "check"]) {
      expect(JSON.stringify((doc[name] as Job).variables ?? {})).not.toContain("CHANT_RUNNER_KEY");
      expect((doc[name] as Job).environment).toBeUndefined();
    }
  });

  test("checkJob and refGateStatus render beside the product's plans", () => {
    const doc = parseYAML(generateGitlabProductPlanPipeline("default", { ...product, checkJob: true, refGateStatus: true }).yaml) as Doc;
    expect((doc.check as Job).script.at(-1)).toBe('yodel chant ci check --base "$BASE_SHA"');
    expect(doc.stages).toContain("ref-gate");
    expect(doc["check-evidence"]).toBeUndefined();
  });
});
