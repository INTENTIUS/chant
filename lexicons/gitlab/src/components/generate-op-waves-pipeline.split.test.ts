/**
 * #4987 on GitLab: before merge each wave is a plan job, a gate job, its
 * applying jobs and a record job. A CI/CD variable reaches every job, so
 * the jobs that run the change's code drop CHANT_FORGE_TOKEN, the job
 * token and the job token in origin's URL right after the head is
 * fetched, before any of the change's code, and again in their
 * after_script. The gate and record jobs fetch the head without checking it
 * out and write `chant/lifecycle`.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  holds: { policy: true },
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }], cloud, environment: { name: "prod" } },
  ],
} as OpWavesSpec;
const options = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  evidence: { identity: "oidc" as const },
  beforeMerge: { merge: "manual" as const },
  beforeScript: ["npm i -g terragucci"],
  waveJobs: { prod: { report: { name: "Report", run: ["terragucci report"] } } },
};

type Job = { stage?: string; needs?: string[]; environment?: { name: string; action?: string }; variables?: Record<string, unknown>; script?: string[]; after_script?: string[]; allow_failure?: unknown; artifacts?: { paths?: string[] } };
const HEAD_CHECKOUT = 'git checkout -q --detach "$CHANT_BEFORE_MERGE_HEAD"';
const SCRUB = `git remote set-url origin "$(git remote get-url origin | sed -E 's#//[^@/]*@#//#')"`;

describe("a split wave before merge on GitLab (#4987)", () => {
  const doc = parseYAML(generateGitlabOpWavesPipeline(spec, options).files[0]!.yaml) as Record<string, Job>;
  const jobs = Object.entries(doc).filter(([, v]) => v && typeof v === "object" && Array.isArray((v as Job).script)) as Array<[string, Job]>;
  const change = jobs.filter(([, job]) => job.script!.some((l) => l.includes(HEAD_CHECKOUT)));

  test("each wave is a plan, a gate, an apply and a record job, chained by needs", () => {
    expect(jobs.map(([n]) => n).filter((n) => n.startsWith("wave-"))).toEqual([
      "wave-1-dev-plan-policy", "wave-1-dev-plan", "wave-1-dev-plan-evidence", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record",
      "wave-2-prod-plan-policy", "wave-2-prod-plan", "wave-2-prod-plan-evidence", "wave-2-prod-gate", "wave-2-prod", "wave-2-prod-record",
    ]);
    expect(doc["wave-1-dev-plan"]!.needs).toEqual(["wave-1-dev-plan-policy"]);
    expect(doc["wave-1-dev-gate"]!.needs).toEqual(["wave-1-dev-plan"]);
    expect(doc["wave-1-dev"]!.needs).toEqual(["wave-1-dev-gate"]);
    // #4992: the record job needs the gate job too, whose decision (an artifact it hands on) names the rows it leased.
    expect(doc["wave-1-dev-record"]!.needs).toEqual(["wave-1-dev", "wave-1-dev-gate"]);
    expect(doc["wave-2-prod-plan"]!.needs).toEqual(["wave-1-dev-record", "wave-2-prod-plan-policy"]);
    expect(doc["wave-2-prod-plan-evidence"]!.needs).toEqual(["wave-2-prod-plan", "wave-2-prod-plan-policy"]);
    expect(doc["before-merge-done"]!.needs).toEqual(["wave-2-prod-record"]);
  });

  test("no job that runs the change's code has CHANT_FORGE_TOKEN or the job token once the head is fetched", () => {
    expect(change.map(([n]) => n)).toEqual(["wave-1-dev-plan-policy", "wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan-policy", "wave-2-prod-plan", "wave-2-prod"]);
    for (const [name, job] of change) {
      const script = job.script!;
      const head = script.findIndex((l) => l.includes(HEAD_CHECKOUT));
      // The scrub and the drop come right after the head's fetch, before the setup, the product's lines and the command.
      expect(script.slice(head + 1, head + 3), name).toEqual([SCRUB, GITLAB_DROP_FORGE_TOKENS]);
      for (const line of ["npm i -g terragucci", ...script.filter((l) => l.startsWith("terragucci run wave"))]) {
        expect(script.indexOf(line), `${name}: ${line}`).toBeGreaterThan(head + 2);
      }
      expect(GITLAB_DROP_FORGE_TOKENS).toContain("CHANT_FORGE_TOKEN");
      expect(GITLAB_DROP_FORGE_TOKENS).toContain("CI_JOB_TOKEN");
      expect(JSON.stringify(job.variables ?? {}), name).not.toContain("CHANT_FORGE_TOKEN");
      if (job.after_script) expect(job.after_script[0], name).toBe(GITLAB_DROP_FORGE_TOKENS);
    }
    expect(doc["wave-2-prod"]!.after_script).toEqual([GITLAB_DROP_FORGE_TOKENS, "terragucci report"]);
  });

  test("the gate job fetches the head without checking it out, and the record job fetches none of it, at the default branch's code", () => {
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record", "wave-2-prod-gate", "wave-2-prod-record"]) {
      const script = doc[name]!.script!;
      expect(script.some((l) => l.includes(HEAD_CHECKOUT)), name).toBe(false);
      expect(script.some((l) => l.includes("refs/merge-requests/${CHANT_BEFORE_MERGE_PR}/head")), name).toBe(name.endsWith("-gate"));
      expect(script, name).not.toContain(GITLAB_DROP_FORGE_TOKENS);
      expect(doc[name]!.environment, name).toBeUndefined();
      expect(doc[name]!.allow_failure, name).toEqual({ exit_codes: [1] });
    }
    expect(doc["wave-2-prod-gate"]!.script!.at(-1)).toBe('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 2 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase gate');
    expect(doc["wave-2-prod-gate"]!.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/wave-2.json", ".chant/op-waves/tf-apply/wave-2/", ".chant/op-waves/tf-apply/outcomes/"]);
  });

  test("the plan job prepares the environment and keeps the saved plan; the applying job deploys and lets its record job run on a moved or held apply", () => {
    expect(doc["wave-2-prod-plan"]!.environment).toEqual({ name: "prod", action: "prepare" });
    expect(doc["wave-2-prod"]!.environment).toEqual({ name: "prod" });
    expect(doc["wave-2-prod-plan"]!.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/wave-2/", ".chant/op-waves/tf-apply/outcomes/", ".chant/op-waves/tf-apply/checks/"]);
    expect(doc["wave-2-prod-plan"]!.allow_failure).toEqual({ exit_codes: [1] });
    expect(doc["wave-2-prod"]!.allow_failure).toEqual({ exit_codes: [1, 4, 5, 6] });
    // The plan job holds no signing identity; its evidence job signs from its status.
    expect(doc["wave-2-prod-plan"]!.variables!.CHANT_WAVE_EVIDENCE).toBe("job");
  });

  test("the environment's approval is asked once a wave: only the applying job deploys, and the plan job prepares planEnvironment when set (#4992)", () => {
    const deploying = Object.entries(doc).filter(([, j]) => j && typeof j === "object" && (j as Job).environment && (j as Job).environment!.action === undefined && (j as Job).environment!.name === "prod");
    expect(deploying.map(([n]) => n)).toEqual(["wave-2-prod"]);
    const read = { ...spec, waves: [spec.waves[0]!, { ...spec.waves[1]!, planEnvironment: { name: "prod-plan" } }] } as OpWavesSpec;
    const withRead = parseYAML(generateGitlabOpWavesPipeline(read, options).files[0]!.yaml) as Record<string, Job>;
    expect(withRead["wave-2-prod-plan"]!.environment).toEqual({ name: "prod-plan", action: "prepare" });
    expect(withRead["wave-2-prod-plan-policy"]!.environment).toEqual({ name: "prod-plan", action: "prepare" });
    expect(JSON.parse(withRead["wave-2-prod-plan"]!.variables!.CHANT_JOB_GUARD as string).forgeEnvironment).toBe("prod-plan");
    expect(withRead["wave-2-prod"]!.environment).toEqual({ name: "prod" });
  });

  test("a step spec splits, and its gate job waits for the rows under the job's timeout (#4992)", () => {
    const step = { ...spec, plan: undefined, apply: undefined, step: { kind: "terragrunt-apply", unit: "{target}" } } as OpWavesSpec;
    const split = parseYAML(generateGitlabOpWavesPipeline(step, options).files[0]!.yaml) as Record<string, Job & { timeout?: string }>;
    expect(split["wave-1-dev-gate"]!.timeout).toBe(split["wave-1-dev"]!.timeout);
    expect(split["wave-1-dev-gate"]!.variables!.CHANT_LOCK_WAIT).toBe(split["wave-1-dev"]!.variables!.CHANT_LOCK_WAIT);
    expect(split["wave-1-dev-record"]!.script!.at(-1)).toContain("--phase record");
  });

  test("without beforeMerge each wave keeps its one job", () => {
    const push = parseYAML(generateGitlabOpWavesPipeline(spec, { ...options, beforeMerge: undefined }).files[0]!.yaml) as Record<string, Job>;
    expect(Object.keys(push).filter((j) => /-(plan|gate|record)$/.test(j))).toEqual([]);
    expect(push["wave-1-dev"]!.script!.at(-1)).toBe("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1");
  });
});
