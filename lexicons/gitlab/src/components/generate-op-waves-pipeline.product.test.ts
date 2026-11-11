/**
 * #4994 on GitLab: a product's `waveJobs` artifact keeps several paths in
 * each split job that runs the change's code, and the gate job runs the
 * product's report of the decision (its `after_script`) and keeps what it
 * wrote with the decision.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

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
      artifact: { name: "terragucci-report-{job}", step: "Keep the gate's report", path: ["terragucci-report/"] },
    },
  },
};

type Job = { after_script?: string[]; artifacts?: { name?: string; paths?: string[] } };

describe("a product's artifact and gate report in a split wave on GitLab (#4994)", () => {
  const doc = parseYAML(generateGitlabOpWavesPipeline(spec, { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" }, waveJobs }).files[0]!.yaml) as Record<string, Job>;

  test("the plan and applying jobs keep each of the product's paths", () => {
    for (const name of ["wave-1-dev-plan", "wave-1-dev"]) {
      expect(doc[name]!.artifacts!.name, name).toBe(`terragucci-report-${name}`);
      expect(doc[name]!.artifacts!.paths, name).toEqual(expect.arrayContaining(["terragucci-report/", "terragucci-respond/"]));
    }
  });

  test("the gate job runs the product's report and keeps it beside the decision; the record job adds nothing", () => {
    const gate = doc["wave-1-dev-gate"]!;
    expect(gate.after_script).toEqual(["terragucci report --gate"]);
    expect(gate.artifacts).toMatchObject({ name: "terragucci-report-wave-1-dev-gate", paths: [".chant/op-waves/tf-apply/wave-1.json", ".chant/op-waves/tf-apply/wave-1/", ".chant/op-waves/tf-apply/outcomes/", "terragucci-report/"] });
    const record = doc["wave-1-dev-record"]!;
    expect(record.after_script).toBeUndefined();
    expect(record.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/outcomes/"]);
  });
});
