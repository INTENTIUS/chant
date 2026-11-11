/**
 * #4994 on GitHub: a product's `waveJobs` artifact keeps several paths in
 * one upload, in the one-job shape and in a split wave's plan and applying
 * jobs, and the gate job runs the product's report of the decision and
 * keeps what it wrote.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "dev", runs: [{ target: "dev" }] }],
} as OpWavesSpec;
const waveJobs = {
  dev: {
    report: { name: "Report", run: ["terragucci report"] },
    artifact: { name: "terragucci-report-{job}", step: "Keep the apply report", path: ["terragucci-report/", "terragucci-respond/"] },
    gate: {
      report: { name: "Report the gate", run: ["terragucci report --gate"] },
      artifact: { name: "terragucci-report-{job}", step: "Keep the gate's report", path: "terragucci-report/" },
    },
  },
};

type Step = { name?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Doc = { jobs: Record<string, { steps: Step[] }> };
const docOf = (beforeMerge: boolean): Doc =>
  parseYAML(generateGithubOpWavesPipeline(spec, { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", waveJobs, ...(beforeMerge ? { beforeMerge: { merge: "manual" as const } } : {}) }).files[0]!.yaml) as Doc;
const step = (doc: Doc, job: string, name: string) => doc.jobs[job]!.steps.find((s) => s.name === name);

describe("a product's artifact and gate report on GitHub (#4994)", () => {
  test("one upload keeps each of the artifact's paths", () => {
    expect(step(docOf(false), "wave-1-dev", "Keep the apply report")!.with).toMatchObject({ name: "terragucci-report-wave-1-dev", path: "terragucci-report/\nterragucci-respond/\n" });
    const split = docOf(true);
    for (const job of ["wave-1-dev-plan", "wave-1-dev"]) expect(step(split, job, "Keep the apply report")!.with, job).toMatchObject({ name: `terragucci-report-${job}`, path: "terragucci-report/\nterragucci-respond/\n" });
  });

  test("the gate job runs the product's report and keeps it; without beforeMerge nothing of `gate` renders", () => {
    const split = docOf(true);
    expect(step(split, "wave-1-dev-gate", "Report the gate")).toMatchObject({ if: "always()", run: "terragucci report --gate" });
    expect(step(split, "wave-1-dev-gate", "Keep the gate's report")!.with).toMatchObject({ name: "terragucci-report-wave-1-dev-gate", path: "terragucci-report/" });
    expect(step(split, "wave-1-dev-record", "Report the gate")).toBeUndefined();
    expect(JSON.stringify(docOf(false))).not.toContain("Report the gate");
  });
});
