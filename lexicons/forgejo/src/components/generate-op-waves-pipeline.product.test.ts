/**
 * #4994 on Forgejo: a product's own uploads in a split wave's jobs go
 * through chant's hand-off. One `waveJobs` artifact keeps every path the
 * product uploaded in steps of its own (its report, its agent's input), the
 * plan and applying jobs hand each path on as their outputs, with no upload
 * after the change's code, and the gate job runs the product's report of
 * the decision and keeps what it wrote.
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
  waves: [{ name: "dev", runs: [{ target: "dev" }] }],
} as OpWavesSpec;
const options = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  beforeMerge: { merge: "manual" as const },
  waveJobs: {
    dev: {
      report: { name: "Report", run: ["terragucci report"] },
      artifact: { name: "terragucci-report-{job}", step: "Keep the apply report", path: ["terragucci-report", "terragucci-respond"] },
      gate: {
        report: { name: "Report the gate", run: ["terragucci report --gate"] },
        artifact: { name: "terragucci-report-{job}", step: "Keep the gate's report", path: ["terragucci-report"] },
      },
    },
  },
};

type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
type Job = { steps: Step[] };
const HEAD_CHECKOUT = 'git checkout -q --detach "$CHANT_BEFORE_MERGE_HEAD"';

describe("a product's uploads through chant's hand-off on Forgejo (#4994)", () => {
  const { jobs } = parseYAML(generateForgejoOpWavesPipeline(spec, options as never).files[0]!.yaml) as { jobs: Record<string, Job> };

  test("a job that runs the change's code uploads nothing and hands on each of the product's paths", () => {
    for (const name of ["wave-1-dev-plan", "wave-1-dev"]) {
      const job = jobs[name]!;
      const checkout = job.steps.findIndex((s) => s.run?.includes(HEAD_CHECKOUT));
      expect(job.steps.slice(checkout + 1).filter((s) => s.uses?.includes("upload-artifact")), name).toEqual([]);
      const handover = job.steps.at(-1)!;
      expect(handover.id, name).toBe("chant-handover");
      expect(handover.run, name).toContain("'terragucci-report' 'terragucci-respond'; do");
    }
  });

  test("the gate and record jobs keep the product's paths as its artifact, named for the job that wrote them", () => {
    const gate = jobs["wave-1-dev-gate"]!;
    expect(gate.steps.find((s) => s.name === "Take the plan job of wave 1 (dev) of tf-apply's files from its outputs")!.run).toContain("'terragucci-report' 'terragucci-respond'; do");
    // A list of paths is one upload's multi-line `path`.
    expect(gate.steps.find((s) => s.name === "Keep the apply report")!.with).toMatchObject({ name: "terragucci-report-wave-1-dev-plan", path: "terragucci-report\nterragucci-respond\n" });
    const record = jobs["wave-1-dev-record"]!;
    expect(record.steps.find((s) => s.name === "Keep the apply report")!.with).toMatchObject({ name: "terragucci-report-wave-1-dev", path: "terragucci-report\nterragucci-respond\n" });
  });

  test("the gate job runs the product's report of the decision and keeps what it wrote", () => {
    const gate = jobs["wave-1-dev-gate"]!;
    const names = gate.steps.map((s) => s.name);
    const report = gate.steps.find((s) => s.name === "Report the gate")!;
    expect(report).toMatchObject({ if: "always()", run: "terragucci report --gate" });
    expect(names.indexOf("Report the gate")).toBeGreaterThan(names.indexOf("Decide wave 1 (dev)'s gate on the saved plan"));
    expect(gate.steps.find((s) => s.name === "Keep the gate's report")!.with).toMatchObject({ name: "terragucci-report-wave-1-dev-gate", path: "terragucci-report" });
    // The record job has no report of its own.
    expect(jobs["wave-1-dev-record"]!.steps.some((s) => s.name === "Report the gate")).toBe(false);
  });
});
