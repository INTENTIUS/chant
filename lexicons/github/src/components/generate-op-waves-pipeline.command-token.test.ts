/**
 * #5044: with `commandToken`, the wave jobs that run only the default
 * branch's code hand their command step the job's token, so the spec's
 * `respond` posts, and ask for the product's permissions beside chant's.
 * A split wave's plan and applying jobs, which run the change's code, never
 * get it. Without it the jobs render as before (the `op-waves-defaults-*`
 * goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { buildGithubOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "canary", runs: [], discover: true, cloud: { aws: { role: "arn:aws:iam::1:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } } },
    { name: "wide", runs: [], discover: true, shares: 2 },
  ],
} as unknown as OpWavesSpec;

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { permissions?: Record<string, string>; steps: Step[] };
const base: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci" };
const token: OpWavesPipelineOptions = { ...base, commandToken: { permissions: { "pull-requests": "write", actions: "read" } } };
const jobsOf = (o: OpWavesPipelineOptions) => buildGithubOpWavesDoc(spec, o).doc.jobsDoc as Record<string, Job>;
const commandOf = (job: Job): Step => job.steps.find((s) => typeof s.run === "string" && s.run.includes("run wave --spec"))!;
const TOKEN = "${{ github.token }}";
const GUARD = "Check the job runs where the spec set it to run";

describe("the wave jobs' command token on GitHub (#5044)", () => {
  test("a push's wave, deciding and share jobs: the token in the command step, the product's permissions on the job", () => {
    const jobs = jobsOf(token);
    for (const name of ["wave-1-canary", "wave-2-wide-decide", "wave-2-wide-share-1", "wave-2-wide-share-2"]) {
      const job = jobs[name]!;
      expect(commandOf(job).env, name).toMatchObject({ GITHUB_TOKEN: TOKEN });
      expect(job.permissions, name).toMatchObject({ contents: "write", "pull-requests": "write", actions: "read" });
      // The token is in the command step alone.
      for (const step of job.steps) if (step !== commandOf(job)) expect(step.env?.GITHUB_TOKEN, `${name}: ${step.name}`).toBeUndefined();
    }
    expect(jobs["wave-1-canary"]!.permissions!["id-token"]).toBe("write");
    expect(jobs["wave-2-wide-decide"]!.permissions!["id-token"]).toBeUndefined();
  });

  test("before merge: the gate and record jobs get it; the plan and applying jobs, which run the change's code, never do", () => {
    const jobs = jobsOf({ ...token, beforeMerge: { merge: "manual" } });
    for (const name of ["wave-1-canary-gate", "wave-1-canary-record", "wave-2-wide-gate", "wave-2-wide-record"]) {
      const job = jobs[name]!;
      const command = job.steps.find((s) => typeof s.run === "string" && / --phase (gate|record)/.test(s.run))!;
      expect(command.env, name).toMatchObject({ GITHUB_TOKEN: TOKEN });
      expect(job.permissions, name).toMatchObject({ contents: "write", "pull-requests": "write", actions: "read" });
    }
    for (const name of ["wave-1-canary-plan", "wave-1-canary", "wave-2-wide-plan", "wave-2-wide-share-1"]) {
      const job = jobs[name]!;
      expect(job.permissions, name).toEqual({ contents: "read", ...(name.startsWith("wave-1") ? { "id-token": "write" } : {}) });
      // The guard reads the decision with the read token, as before; no step after it holds one.
      for (const step of job.steps.filter((s) => s.name !== GUARD)) expect(step.env?.GITHUB_TOKEN, `${name}: ${step.name}`).toBeUndefined();
    }
  });

  test("a pr-review wave's gate keeps pull-requests: read unless the product asks for more", () => {
    const review = { ...spec, waves: spec.waves.map((w) => ({ ...w, approval: "pr-review" })) } as unknown as OpWavesSpec;
    const gate = (o: OpWavesPipelineOptions) => (buildGithubOpWavesDoc(review, { ...o, beforeMerge: { merge: "manual" } }).doc.jobsDoc as Record<string, Job>)["wave-1-canary-gate"]!;
    expect(gate({ ...base, commandToken: { permissions: { actions: "read" } } }).permissions).toMatchObject({ "pull-requests": "read", actions: "read" });
    expect(gate(token).permissions).toMatchObject({ "pull-requests": "write" });
  });

  test("without it, or with no permissions, nothing but the token changes", () => {
    const before = jobsOf(base);
    expect(commandOf(before["wave-2-wide-decide"]!).env).toBeUndefined();
    expect(before["wave-2-wide-decide"]!.permissions).toBeUndefined();
    const bare = jobsOf({ ...base, commandToken: {} });
    expect(commandOf(bare["wave-2-wide-decide"]!).env).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(bare["wave-2-wide-decide"]!.permissions).toEqual({ contents: "write" });
  });

  test("GitLab's cache is refused here (#5045): a wave's setup step restores one", () => {
    expect(() => jobsOf({ ...base, cache: { key: "k", paths: ["p/"] } })).toThrow(/setup step that uses actions\/cache/);
  });

  test("refused: chant's own scopes, a scope GitHub does not know, a level that is not read or write", () => {
    expect(() => jobsOf({ ...base, commandToken: { permissions: { contents: "write" } } })).toThrow(/chant sets on the wave jobs itself/);
    expect(() => jobsOf({ ...base, commandToken: { permissions: { "id-token": "write" } } })).toThrow(/chant sets on the wave jobs itself/);
    expect(() => jobsOf({ ...base, commandToken: { permissions: { everything: "write" } as never } })).toThrow(/not a GitHub permission scope/);
    expect(() => jobsOf({ ...base, commandToken: { permissions: { actions: "admin" } as never } })).toThrow(/give read or write/);
  });
});
