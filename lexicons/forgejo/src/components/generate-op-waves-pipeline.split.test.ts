/**
 * #4987 on Forgejo: the split before-merge waves in Forgejo's dialect.
 * Forgejo ignores `permissions:`, so its job token can write; the jobs that
 * run the change's code keep it to the checkout step's environment, check
 * out with git and no actions/checkout (whose credentials stay in the git
 * config and whose post step takes the token again), and start every later
 * step without the token variables.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }, { target: "prod-eu" }], shares: 2, idTokens: { CLOUD_TOKEN: "sts.example.com" } },
  ],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string };
type Job = { needs?: string[]; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
const HEAD_CHECKOUT = 'git checkout -q --detach "$CHANT_BEFORE_MERGE_HEAD"';
const TOKEN = /\$\{\{\s*(github\.token|secrets\.)/;

describe("a split wave before merge on Forgejo (#4987)", () => {
  const { jobs } = parseYAML(generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml) as { jobs: Record<string, Job> };
  const change = Object.entries(jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)));

  test("each wave is a plan, a gate, its applying jobs and a record job", () => {
    expect(Object.keys(jobs)).toEqual(["wave-1-dev-plan", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record", "wave-2-prod-plan", "wave-2-prod-gate", "wave-2-prod-share-1", "wave-2-prod-share-2", "wave-2-prod-record", "before-merge-done"]);
    expect(change.map(([n]) => n)).toEqual(["wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan", "wave-2-prod-share-1", "wave-2-prod-share-2"]);
  });

  test("no job that runs the change's code has a write token or persisted credentials", () => {
    for (const [name, job] of change) {
      // The dialect keeps id-token: write alone, for a wave's OIDC tokens.
      expect(Object.keys(job.permissions ?? {}).filter((s) => s !== "id-token"), name).toEqual([]);
      expect(job.steps.filter((s) => s.uses?.includes("checkout")), name).toEqual([]);
      expect(JSON.stringify(job.env ?? {}), name).not.toMatch(TOKEN);
      const checkout = job.steps.findIndex((s) => s.run?.includes(HEAD_CHECKOUT));
      expect(job.steps[checkout]!.env, name).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
      job.steps.forEach((step, i) => {
        if (i !== 0 && i !== checkout) expect(JSON.stringify(step.env ?? {}), `${name} step ${i}`).not.toMatch(TOKEN);
        if (i > checkout && step.run !== undefined) expect(step.run.startsWith('if [ -z "${CHANT_NO_FORGE_TOKEN:-}" ]'), `${name} step ${step.name ?? i}`).toBe(true);
      });
    }
    expect(jobs["wave-2-prod-share-1"]!.permissions).toEqual({ "id-token": "write" });
    // The gate and record jobs check out the default branch alone.
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record", "wave-2-prod-gate", "wave-2-prod-record"]) {
      expect(jobs[name]!.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)), name).toBe(false);
      expect(jobs[name]!.steps.some((s) => /--phase (gate|record)$/.test(s.run ?? "")), name).toBe(true);
    }
  });
});
