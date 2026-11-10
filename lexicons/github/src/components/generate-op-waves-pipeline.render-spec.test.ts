/**
 * #4982 on github: a spec the job renders at run time. The generator
 * writes the fixed job shape from the spec it is handed (the guard, the
 * cloud trade, the policy step, the command step, the evidence job), and
 * each wave job's command and policy step pass `--render-spec`, with the
 * product's command in `CHANT_WAVES_SPEC_COMMAND`.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
// terragucci's shape: a Terragrunt repo's waves find their units when they plan, and the last runs the rest.
const shape: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  step: { kind: "terragrunt-apply", unit: "{target}", layers: [["live/dev"], ["live/prod"]] },
  holds: { policy: true },
  waves: [
    { name: "wave-1", runs: [], discover: true, together: true, cloud },
    { name: "wave-2", runs: [], discover: true, together: true, rest: true, cloud },
  ],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", renderSpec: { command: ["terragucci", "waves-spec"] }, evidence: { identity: "oidc" as const } };

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string };
type Job = { needs?: string[]; env?: Record<string, string>; permissions?: Record<string, string>; steps: Step[] };
const jobsOf = (s: OpWavesSpec, o: Record<string, unknown>): Record<string, Job> => (parseYAML(generateGithubOpWavesPipeline(s, { specFile: options.specFile, ...o }).files[0]!.yaml) as { jobs: Record<string, Job> }).jobs;

describe("a spec the job renders at run time on github (#4982)", () => {
  test("each wave job renders the spec through the product's command, in the fixed job shape", () => {
    const jobs = jobsOf(shape, options);
    expect(Object.keys(jobs)).toEqual(["wave-1-wave-1", "wave-1-wave-1-evidence", "wave-2-wave-2", "wave-2-wave-2-evidence"]);
    const wave = jobs["wave-1-wave-1"]!;
    expect(wave.env!.CHANT_WAVES_SPEC_COMMAND).toBe('["terragucci","waves-spec"]');
    expect(wave.steps[0]!.name).toBe("Check the job runs where the spec set it to run");
    expect(wave.steps[1]!.name).toBe("Trade the job's OIDC token for its cloud identities");
    const policy = wave.steps.find((s) => s.id === "chant-policy")!;
    expect(policy.run).toContain("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --render-spec --policy-only");
    const command = wave.steps.find((s) => s.name === "Plan, gate and apply wave 1 (wave-1)")!;
    expect(command.run!.trim()).toMatch(/terragucci run wave --spec \.chant\/op-waves\/tf-apply\.spec\.json --wave 1 --render-spec$/);
    expect(command.env).toEqual({ CHANT_WAVE_EVIDENCE: "job" });
    // The evidence job runs none of the change's code and renders no spec.
    const ev = jobs["wave-1-wave-1-evidence"]!;
    expect(ev.env?.CHANT_WAVES_SPEC_COMMAND).toBeUndefined();
    expect(ev.steps.at(-1)!.run).toContain("terragucci ci evidence sign --from-job wave-1-wave-1 --check-id plan:wave-1,policy:wave-1 ");
  });

  test("a wave split across share jobs renders the spec in its deciding and share jobs", () => {
    const plain: OpWavesSpec = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "wave-1", runs: [{ target: "a" }, { target: "b" }], shares: 2 }] } as OpWavesSpec;
    const jobs = jobsOf(plain, { bin: "terragucci", renderSpec: options.renderSpec });
    for (const name of ["wave-1-wave-1-decide", "wave-1-wave-1-share-1", "wave-1-wave-1-share-2"]) {
      expect(jobs[name]!.env!.CHANT_WAVES_SPEC_COMMAND).toBe('["terragucci","waves-spec"]');
      expect(jobs[name]!.steps.some((s) => s.run?.includes("--render-spec"))).toBe(true);
    }
  });

  test("without renderSpec the jobs read the committed spec as before", () => {
    const jobs = jobsOf(shape, { bin: "terragucci", evidence: options.evidence });
    const wave = jobs["wave-1-wave-1"]!;
    expect(wave.env!.CHANT_WAVES_SPEC_COMMAND).toBeUndefined();
    expect(wave.steps.some((s) => s.run?.includes("--render-spec"))).toBe(false);
  });

  test("a renderSpec with no command is refused", () => {
    expect(() => jobsOf(shape, { renderSpec: { command: [] } })).toThrow(/renderSpec.command must be the product command/);
  });
});
