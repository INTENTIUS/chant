/**
 * #4987 on GitHub: before merge each wave is a plan job, a gate job, its
 * applying jobs and a record job, so no job that runs the change's code
 * holds a write token or keeps credentials in its checkout, and the jobs
 * that write `chant/lifecycle` run the default branch's code alone.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const splitSpec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  notify: { slack: "SLACK_WEBHOOK" },
  holds: { policy: true },
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "fleet", runs: [{ target: "a" }, { target: "b" }, { target: "c" }], shares: 2 },
    { name: "prod", runs: [{ target: "prod" }], cloud, environment: { name: "prod" } },
  ],
} as OpWavesSpec;
const splitOptions = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  evidence: { identity: "oidc" as const },
  beforeMerge: { merge: "manual" as const },
  waveJobs: { prod: { before: [{ name: "Log in", run: ["login"] }], report: { name: "Report", run: ["report"] } } },
};

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown>; if?: string };
type Job = { needs?: string[]; if?: string; env?: Record<string, string>; permissions?: Record<string, string>; environment?: unknown; steps: Step[] };
type Doc = { env?: Record<string, string>; jobs: Record<string, Job> };

/** The line that checks the decided head out: a job with it runs the change's code. */
const HEAD_CHECKOUT = 'git checkout -q --detach "$CHANT_BEFORE_MERGE_HEAD"';
/** The first line of every step that runs after the checkout in such a job. */
const DROPS_TOKENS = 'if [ -z "${CHANT_NO_FORGE_TOKEN:-}" ]';
const TOKEN = /\$\{\{\s*(github\.token|secrets\.)/;

/** Every job that checks the decided head out, and what it holds. */
function changeJobs(doc: Doc): Array<[string, Job]> {
  return Object.entries(doc.jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)));
}

/** The shared check: a job that runs the change's code holds no write token and keeps no credentials. */
function expectNoWriteTokenBesideTheChange(doc: Doc, forge: "github" | "forgejo"): void {
  const change = changeJobs(doc);
  expect(change.length).toBeGreaterThan(0);
  for (const [name, job] of change) {
    // No permission but the OIDC token's writes; Forgejo keeps that one alone.
    const writes = Object.entries(job.permissions ?? {}).filter(([scope, level]) => level === "write" && scope !== "id-token");
    expect(writes, name).toEqual([]);
    if (forge === "github") expect(job.permissions?.contents, name).toBe("read");
    // No actions/checkout, whose credentials stay in .git/config and whose post step takes the token again at the job's end.
    expect(job.steps.filter((s) => s.uses?.startsWith("actions/checkout")), name).toEqual([]);
    expect(JSON.stringify(job.env ?? {}), name).not.toMatch(TOKEN);
    const checkout = job.steps.findIndex((s) => s.run?.includes(HEAD_CHECKOUT));
    expect(job.steps[checkout]!.run, name).not.toContain("persist");
    job.steps.forEach((step, i) => {
      // The token reaches the guard (which reads the decision) and the checkout's fetches, in their own steps' environment.
      if (i !== 0 && i !== checkout) expect(JSON.stringify(step.env ?? {}), `${name} step ${i}`).not.toMatch(TOKEN);
      if (i > checkout && step.run !== undefined) expect(step.run.startsWith(DROPS_TOKENS), `${name} step ${step.name ?? i}`).toBe(true);
    });
  }
  // Every job that may write the repository runs none of the change's code.
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (job.permissions?.contents !== "write" && forge === "github") continue;
    if (change.some(([n]) => n === name)) continue;
    expect(job.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)), name).toBe(false);
  }
}

const docOf = (o: Record<string, unknown> = {}): Doc => parseYAML(generateGithubOpWavesPipeline(splitSpec, { ...splitOptions, ...o } as never).files[0]!.yaml) as Doc;

describe("a split wave before merge on GitHub (#4987)", () => {
  const doc = docOf();

  test("each wave is a plan, a gate, its applying jobs and a record job, chained by needs", () => {
    const waves = Object.keys(doc.jobs).filter((j) => j.startsWith("wave-") && !j.endsWith("-evidence"));
    expect(waves).toEqual([
      "wave-1-dev-plan", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record",
      "wave-2-fleet-plan", "wave-2-fleet-gate", "wave-2-fleet-share-1", "wave-2-fleet-share-2", "wave-2-fleet-record",
      "wave-3-prod-plan", "wave-3-prod-gate", "wave-3-prod", "wave-3-prod-record",
    ]);
    expect(doc.jobs["wave-1-dev-plan"]!.needs).toBeUndefined();
    expect(doc.jobs["wave-1-dev-gate"]!.needs).toEqual(["wave-1-dev-plan"]);
    expect(doc.jobs["wave-1-dev"]!.needs).toEqual(["wave-1-dev-gate"]);
    expect(doc.jobs["wave-2-fleet-plan"]!.needs).toEqual(["wave-1-dev-record"]);
    expect(doc.jobs["wave-2-fleet-share-2"]!.needs).toEqual(["wave-2-fleet-gate"]);
    expect(doc.jobs["wave-2-fleet-record"]!.needs).toEqual(["wave-2-fleet-share-1", "wave-2-fleet-share-2"]);
    expect(doc.jobs["wave-2-fleet-share-2"]!.steps.find((s) => s.name === "Apply share 2 of wave 2 (fleet) from the saved plan")!.run).toContain("--wave 2 --base \"${CHANT_WAVES_BASE:-HEAD^1}\" --share 2 --phase apply");
  });

  test("no job that runs the change's code has a write token or persisted credentials", () => {
    expectNoWriteTokenBesideTheChange(doc, "github");
    expect(changeJobs(doc).map(([n]) => n)).toEqual(["wave-1-dev-plan", "wave-1-dev", "wave-2-fleet-plan", "wave-2-fleet-share-1", "wave-2-fleet-share-2", "wave-3-prod-plan", "wave-3-prod"]);
    // After the trade the token request is dropped too, and the product's report runs without a token.
    const prod = doc.jobs["wave-3-prod"]!;
    expect(prod.steps.find((s) => s.name === "Log in")!.run).toContain("-u ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(prod.steps.find((s) => s.name === "Report")!.run!.startsWith(DROPS_TOKENS)).toBe(true);
  });

  test("the gate and record jobs run the default branch's code with the token, and alone carry the notify secrets", () => {
    for (const name of ["wave-3-prod-gate", "wave-3-prod-record"]) {
      const job = doc.jobs[name]!;
      expect(job.permissions).toEqual({ contents: "write" });
      expect(job.steps[1]!.uses).toMatch(/^actions\/checkout@/);
      expect(job.env).toMatchObject({ SLACK_WEBHOOK: "${{ secrets.SLACK_WEBHOOK }}" });
    }
    // The gate reads the decided head's commit without checking it out; the record job writes what ran, whatever the pull request did since.
    expect(doc.jobs["wave-3-prod-gate"]!.steps[2]!.name).toBe("Fetch the pull request's decided head without checking it out");
    expect(JSON.stringify(doc.jobs["wave-3-prod-record"]!.steps)).not.toContain("refs/pull/");
    expect(doc.env?.SLACK_WEBHOOK).toBeUndefined();
    for (const [name] of changeJobs(doc)) expect(doc.jobs[name]!.env?.SLACK_WEBHOOK, name).toBeUndefined();
    expect(doc.jobs["wave-3-prod-gate"]!.steps.find((s) => s.name === "Decide wave 3 (prod)'s gate on the saved plan")!.run).toBe('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 3 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase gate');
    expect(doc.jobs["wave-3-prod-record"]!.steps.at(-1)!.run).toBe('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 3 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase record');
  });

  test("the saved plan goes from the plan job through the gate to the applying job, which runs only on the gate's success", () => {
    const plan = doc.jobs["wave-1-dev-plan"]!;
    expect(plan.steps.find((s) => s.name === "Keep wave 1's saved plan")!.with).toMatchObject({ name: "tf-apply-wave-1-plan", path: ".chant/op-waves/tf-apply/wave-1" });
    expect(doc.jobs["wave-1-dev-gate"]!.steps.find((s) => s.name === "Download wave 1's saved plan")!.with).toEqual({ name: "tf-apply-wave-1-plan", path: ".chant/op-waves/tf-apply/wave-1" });
    expect(doc.jobs["wave-1-dev-gate"]!.if).toBe("${{ !cancelled() }}");
    const apply = doc.jobs["wave-1-dev"]!;
    expect(apply.if).toBe("${{ !cancelled() && needs.wave-1-dev-gate.result == 'success' }}");
    expect(apply.steps.map((s) => s.name)).toEqual(expect.arrayContaining(["Download wave 1's decision", "Download wave 1's saved plan", "Apply wave 1 (dev)'s saved plan"]));
    expect(apply.steps.find((s) => s.name === "Keep the job's outcome and run record")!.with!.path).toBe(".chant/op-waves/tf-apply/outcomes/outcome-wave-1-apply.json\n.chant/op-waves/tf-apply/outcomes/run-record-wave-1.json\n");
    expect(doc.jobs["wave-1-dev-record"]!.if).toBe("${{ !cancelled() && !contains(needs.*.result, 'skipped') }}");
  });

  test("the plan job runs the policy step, and its evidence job signs; the plan job holds no signing identity", () => {
    const plan = doc.jobs["wave-1-dev-plan"]!;
    expect(plan.steps.find((s) => s.name === "Check wave 1 (dev)'s plans against the policy")!.run).toContain("--phase plan --policy-only");
    expect(plan.permissions).toEqual({ contents: "read" });
    const evidence = doc.jobs["wave-1-dev-plan-evidence"]!;
    expect(evidence.needs).toEqual(["wave-1-dev-plan"]);
    expect(evidence.steps.at(-1)!.run).toContain("--check-id plan:dev,policy:dev");
    expect(JSON.parse(evidence.steps.at(-1)!.env!.CHANT_EVIDENCE_SOURCES!)).toEqual({ "plan:dev": { step: "Plan wave 1 (dev) and save the plan" }, "policy:dev": { step: "Check wave 1 (dev)'s plans against the policy" } });
  });

  test("a step spec or a rest wave cannot split, and is refused with beforeMerge alone", () => {
    const step = { ...splitSpec, plan: undefined, apply: undefined, step: { kind: "terraform-apply", root: "{target}" } } as never;
    expect(() => generateGithubOpWavesPipeline(step, splitOptions as never)).toThrow("a spec with `step` plans in the job's own process");
    expect(() => generateGithubOpWavesPipeline(step, { ...splitOptions, beforeMerge: undefined } as never)).not.toThrow();
    const rest = { ...splitSpec, plan: undefined, planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"], waves: [...splitSpec.waves.slice(0, 2), { ...splitSpec.waves[2]!, rest: true, discover: true, runs: [] }] } as never;
    expect(() => generateGithubOpWavesPipeline(rest, splitOptions as never)).toThrow('wave "prod" has `rest`');
  });

  test("without beforeMerge each wave keeps its one job", () => {
    const push = docOf({ beforeMerge: undefined });
    expect(Object.keys(push.jobs).filter((j) => /-(plan|gate|record)$/.test(j))).toEqual([]);
    expect(push.env?.SLACK_WEBHOOK).toBe("${{ secrets.SLACK_WEBHOOK }}");
  });
});
