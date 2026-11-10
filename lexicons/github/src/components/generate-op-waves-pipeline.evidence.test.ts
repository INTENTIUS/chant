/**
 * #4926 on github: a wave's policy is a step of its own, and an evidence job
 * after the wave job signs `policy:<wave>` from that step's result, and
 * `plan:<wave>` too for a wave that trades cloud credentials and signs
 * keyless. A pipeline with no policy and no keyless cloud trade renders as
 * before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  holds: { policy: true },
  evidence: { requires: ["policy:dev"] },
  waves: [{ name: "dev", runs: [{ target: "network" }], cloud }, { name: "prod", runs: [{ target: "network" }] }],
};
const waves = { specFile: ".chant/op-waves/roots.spec.json", bin: "tg chant" };

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string };
type Job = { needs?: string[]; if?: string; permissions?: Record<string, string>; steps: Step[] };
const jobsOf = (s: OpWavesSpec, evidence: object): Record<string, Job> => (parseYAML(generateGithubOpWavesPipeline(s, { ...waves, evidence }).files[0]!.yaml) as { jobs: Record<string, Job> }).jobs;

describe("a wave's evidence job on github (#4926)", () => {
  test("a keyless wave that trades cloud credentials gets an evidence job that signs plan and policy from the steps' results", () => {
    const jobs = jobsOf(spec, { identity: "oidc" });
    const wave = jobs["wave-1-dev"]!;
    const policy = wave.steps.find((s) => s.id === "chant-policy")!;
    expect(policy.name).toBe("Check wave 1 (dev)'s plans against the policy");
    expect(policy.run).toContain("tg chant run wave --spec .chant/op-waves/roots.spec.json --wave 1 --policy-only");
    // After the trade, the policy step requests no token either.
    expect(policy.run!.startsWith("unset ACTIONS_ID_TOKEN_REQUEST_TOKEN")).toBe(true);
    const command = wave.steps.find((s) => s.name === "Plan, gate and apply wave 1 (dev)")!;
    expect(command.if).toBe("${{ !cancelled() && (success() || steps.chant-policy.outcome == 'failure') }}");
    // The command step signs nothing: no identity on it, and its claim file is left for the evidence job.
    expect(command.env).toEqual({ CHANT_WAVE_EVIDENCE: "job" });
    expect(wave.steps.some((s) => s.name === "Keep the job's check claims")).toBe(true);

    const ev = jobs["wave-1-dev-evidence"]!;
    expect(ev.needs).toEqual(["wave-1-dev"]);
    expect(ev.if).toBe("!cancelled()");
    expect(ev.permissions).toEqual({ contents: "write", actions: "read", "id-token": "write" });
    const runs = ev.steps.map((s) => s.run ?? s.uses ?? "").join("\n");
    // The base is checked out before anything of the product runs.
    expect(runs).toMatch(/git checkout --quiet --detach "\$CHANT_EVIDENCE_BASE"/);
    const sign = ev.steps.at(-1)!;
    expect(sign.run).toBe('tg chant ci evidence sign --from-job wave-1-dev --check-id plan:dev,policy:dev --claims .chant/op-waves/roots/checks --at "$GITHUB_SHA" --base "$CHANT_EVIDENCE_BASE"');
    expect(sign.env!.CHANT_RUNNER_IDENTITY).toBe("oidc");
    expect(JSON.parse(sign.env!.CHANT_EVIDENCE_SOURCES!)).toEqual({ "plan:dev": { step: "Plan, gate and apply wave 1 (dev)" }, "policy:dev": { step: "Check wave 1 (dev)'s plans against the policy" } });
  });

  test("a wave without a cloud trade signs its plan in its own step and its policy in the evidence job", () => {
    const jobs = jobsOf(spec, { identity: "oidc" });
    const command = jobs["wave-2-prod"]!.steps.find((s) => s.name === "Plan, gate and apply wave 2 (prod)")!;
    expect(command.env).toEqual({ CHANT_RUNNER_IDENTITY: "oidc", CHANT_WAVE_EVIDENCE: "plan" });
    const sign = jobs["wave-2-prod-evidence"]!.steps.at(-1)!;
    expect(sign.run).toContain("--from-job wave-2-prod --check-id policy:prod ");
  });

  test("an apply wave whose evidence.requires names an earlier wave's check waits for that wave's evidence job", () => {
    expect(jobsOf(spec, { identity: "oidc" })["wave-2-prod"]!.needs).toEqual(["wave-1-dev", "wave-1-dev-evidence"]);
    expect(jobsOf({ ...spec, evidence: {} }, { identity: "oidc" })["wave-2-prod"]!.needs).toEqual(["wave-1-dev"]);
  });

  test("with a runner key, the evidence job signs policy with the key, and the cloud wave signs its plan in its step", () => {
    const jobs = jobsOf(spec, { runnerKeySecret: "CHANT_RUNNER_KEY_PEM" });
    const sign = jobs["wave-1-dev-evidence"]!.steps.at(-1)!;
    expect(sign.run).toContain("--check-id policy:dev ");
    expect(sign.env!.CHANT_RUNNER_KEY).toBe("${{ secrets.CHANT_RUNNER_KEY_PEM }}");
    expect(jobs["wave-1-dev-evidence"]!.permissions).toEqual({ contents: "write", actions: "read" });
  });

  test("without a policy or a keyless cloud trade the wave jobs render as before, with no evidence job", () => {
    const plain: OpWavesSpec = { ...spec, holds: undefined, waves: [{ name: "dev", runs: [{ target: "network" }] }] };
    const jobs = jobsOf(plain, { identity: "oidc" });
    expect(Object.keys(jobs)).toEqual(["wave-1-dev"]);
    expect(jobs["wave-1-dev"]!.steps.find((s) => s.name === "Plan, gate and apply wave 1 (dev)")!.env).toEqual({ CHANT_RUNNER_IDENTITY: "oidc" });
  });
});
