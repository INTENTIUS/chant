/**
 * #5044: on Forgejo `commandToken` hands the command step the job's token
 * too, as on GitHub. Forgejo reads no `permissions:`; the split plan and
 * applying jobs still never hold the token past their checkout.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "canary", runs: [], discover: true }],
} as unknown as OpWavesSpec;

type Step = { run?: string; env?: Record<string, string> };
const jobsOf = (o: Record<string, unknown>) => buildForgejoOpWavesDoc(spec, { specFile: "w.json", commandToken: { permissions: { "pull-requests": "write" } }, ...o }).doc.jobsDoc as Record<string, { steps: Step[] }>;

describe("the wave jobs' command token on Forgejo (#5044)", () => {
  test("a push's wave job and a split wave's gate and record jobs get it in the command step; the plan and applying jobs do not", () => {
    const command = (steps: Step[]) => steps.find((s) => typeof s.run === "string" && s.run.includes("run wave --spec"))!;
    expect(command(jobsOf({})["wave-1-canary"]!.steps).env).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}" });
    const split = jobsOf({ beforeMerge: { merge: "manual" } });
    for (const name of ["wave-1-canary-gate", "wave-1-canary-record"]) expect(command(split[name]!.steps).env, name).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}" });
    // The guard reads the decision with the token, as before; no step after it holds one.
    for (const name of ["wave-1-canary-plan", "wave-1-canary"]) for (const step of split[name]!.steps.slice(1)) expect(step.env?.GITHUB_TOKEN, name).toBeUndefined();
  });
});
