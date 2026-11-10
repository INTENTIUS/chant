/**
 * #4935 and #4899 on github: the pull request loop's note job signs plan and
 * policy with `evidence`; the check, check evidence and ref gate jobs come
 * with `checkJob` and `refGateStatus` in the loop and the product plan
 * pipeline; and the product plan's `record` writes the run record into the
 * hand-off for the note job to keep. Without the options every file is the
 * one generated before.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";
import { generateProductPlanPipeline } from "./product-plan-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string; id?: string; if?: string };
type Job = { if?: string; needs?: string[]; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] };
type Doc = { jobs: Record<string, Job> };
const loopYaml = (prLoop: Record<string, unknown>) => generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml;
const loop = (prLoop: Record<string, unknown>) => parseYAML(loopYaml(prLoop)) as Doc;

describe("the pull request loop's evidence, check and ref gate jobs on github (#4935)", () => {
  test("without the options the workflow is unchanged", () => {
    expect(loopYaml({ words: WORDS, evidence: undefined, checkJob: false, refGateStatus: false })).toBe(loopYaml({ words: WORDS }));
    const plain = loop({ words: WORDS });
    expect(Object.keys(plain.jobs)).not.toContain("check");
    expect(loopYaml({ words: WORDS })).not.toContain("ci evidence");
  });

  test("with a runner key secret the note job signs plan and policy before it posts", () => {
    const note = loop({ words: WORDS, evidence: { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" } }).jobs["plan-note"]!;
    expect(note.permissions!.contents).toBe("write");
    expect(note.permissions!["id-token"]).toBeUndefined();
    const names = note.steps.map((s) => s.name);
    const sign = note.steps.find((s) => s.name === "Sign the plan and policy evidence")!;
    expect(names.indexOf(sign.name)).toBeLessThan(names.findIndex((n) => n?.startsWith("Post the plan note")));
    expect(sign.run).toContain('npx --no-install plywood ci evidence sign --from-report .chant/pr --result "$PLAN_RESULT" --at "$HEAD_SHA" --base "$BASE_SHA"');
    expect(sign.env!.CHANT_RUNNER_KEY).toBe("${{ secrets.CHANT_RUNNER_KEY_PEM }}");
    expect(sign.env!.PLAN_RESULT).toBe("${{ needs.plan.result }}");
  });

  test("signing keyless the note job asks for its OIDC token", () => {
    const note = loop({ words: WORDS, evidence: { identity: "oidc" } }).jobs["plan-note"]!;
    expect(note.permissions!["id-token"]).toBe("write");
    expect(note.steps.find((s) => s.name === "Sign the plan and policy evidence")!.env!.CHANT_RUNNER_IDENTITY).toBe("oidc");
  });

  test("the check job runs ci check without the token, last, handing its report on", () => {
    const check = loop({ words: WORDS, checkJob: true }).jobs.check!;
    expect(check.permissions).toEqual({ contents: "read" });
    expect(check.outputs!.report_0).toBe("${{ steps.check.outputs.report_0 }}");
    expect(check.steps[0]!.env).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
    const last = check.steps.at(-1)!;
    expect(last.id).toBe("check");
    expect(last.run).toMatch(/^if .*unset .*GITHUB_TOKEN/);
    expect(last.run!.trimEnd().split("\n").at(-1)).toBe('npx --no-install plywood ci check --base "$BASE_SHA"');
    expect(JSON.stringify(check)).not.toContain("CHANT_RUNNER_KEY");
  });

  test("with evidence the check evidence job signs each passed hook from the report at the target branch's commit", () => {
    const doc = loop({ words: WORDS, checkJob: true, evidence: { runnerKeySecret: "K" } });
    const ev = doc.jobs["check-evidence"]!;
    expect(ev.needs).toEqual(["check"]);
    expect(ev.permissions).toEqual({ contents: "write" });
    expect(ev.steps[0]!.uses).toMatch(/^actions\/checkout/);
    const sign = ev.steps.find((s) => s.name?.startsWith("Sign"))!;
    expect(sign.run).toContain('ci evidence sign --from-report .chant/check --result "$CHECK_RESULT"');
    expect(sign.env!.CHANT_RUNNER_KEY).toBe("${{ secrets.K }}");
    expect(doc.jobs.check!.steps.some((s) => JSON.stringify(s).includes("secrets.K"))).toBe(false);
  });

  test("the ref gate job sets the status once the note and the check evidence are in", () => {
    const doc = loop({ words: WORDS, checkJob: true, refGateStatus: true, evidence: { runnerKeySecret: "K" }, branch: "trunk" });
    const gate = doc.jobs["ref-gate"]!;
    expect(gate.needs).toEqual(["plan-note", "check-evidence"]);
    expect(gate.permissions).toEqual({ contents: "read", statuses: "write" });
    const step = gate.steps.at(-1)!;
    expect(step.run).toContain("refs/notes/chant/evidence");
    expect(step.run!.trimEnd().split("\n").at(-1)).toBe('npx --no-install plywood workspace ref-gate status --ref refs/heads/trunk --at "$HEAD_SHA" --base "$BASE_SHA"');
    expect(step.env).toEqual({ HEAD_SHA: "${{ github.sha }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("a member's pipeline refuses them", () => {
    expect(() => generateGithubPipeline(ESTATE, { env: "prod", member: { name: "app", dir: "app" }, prLoop: { checkJob: true } } as never)).toThrow(/root pipeline, not member app's/);
  });
});

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const product = { words: yodel, productPlan: { command: "yodel plan {target} --pr-note {output}", targets: [{ name: "staging" }, { name: "prod" }] } };

describe("the product plan's record and check jobs on github (#4899, #4935)", () => {
  test("without the options the workflow is unchanged", () => {
    expect(generateProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, record: false } }).yaml).toBe(generateProductPlanPipeline("default", product).yaml);
  });

  test("record: the plan step writes the run record, and the note job keeps it with contents: write", () => {
    const doc = parseYAML(generateProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, record: true } }).yaml) as Doc;
    const plan = doc.jobs["plan-staging"]!.steps.at(-1)!;
    expect(plan.run).toContain('chant_plan_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(plan.run).toContain('CHANT_PLAN_EXIT="$chant_plan_exit" CHANT_PLAN_STARTED="$chant_plan_started" node -e');
    expect(plan.run!.trimEnd().split("\n").at(-1)).toBe('[ "$chant_plan_exit" -eq 0 ] || exit "$chant_plan_exit"');
    expect(JSON.parse(plan.env!.CHANT_PLAN_RECORD!)).toEqual({ op: "pr-plan", env: "default", labels: { Env: "default", Pipeline: "pr", Job: "plan", Target: "staging" } });
    const note = doc.jobs["plan-note-staging"]!;
    expect(note.permissions!.contents).toBe("write");
    expect(note.steps.at(-1)!.run).toMatch(/--record-run plan-staging$/);
  });

  test("checkJob and refGateStatus: the check job runs for forks too, the credentialed jobs do not", () => {
    const doc = parseYAML(generateProductPlanPipeline("default", { ...product, productPlan: { ...product.productPlan, forks: "skip" as const }, checkJob: true, refGateStatus: true, evidence: { identity: "oidc" as const } }).yaml) as Doc;
    expect(doc.jobs.check!.if).toBe("github.event_name == 'pull_request'");
    expect(doc.jobs.check!.steps.at(-1)!.run!.trimEnd().split("\n").at(-1)).toBe('yodel chant ci check --base "$BASE_SHA"');
    expect(doc.jobs["check-evidence"]!.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(doc.jobs["check-evidence"]!.permissions!["id-token"]).toBe("write");
    expect(doc.jobs["ref-gate"]!.needs).toEqual(["plan-note-staging", "plan-note-prod", "check-evidence"]);
  });
});
