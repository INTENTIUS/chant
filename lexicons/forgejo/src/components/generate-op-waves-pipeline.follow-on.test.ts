/**
 * #4992 on Forgejo: a split pipeline's `rest` wave runs one wave per run.
 * The record job dispatches the follow-on with the `CHANT_FORGE_TOKEN`
 * secret in its own step, and the plan job's hand-off carries the files of
 * the wave the run names: a round trip with `CHANT_WAVES_WAVE=4` lands them
 * at wave 4's paths in the gate job.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "layer-1", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; env?: Record<string, string>; steps: Step[] };
type Doc = { on: { workflow_dispatch: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };

describe("a rest wave before merge on Forgejo runs one wave per run (#4992)", () => {
  const doc = parseYAML(generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml) as Doc;

  test("the workflow takes the follow-on's inputs, and the waves before the rest wave do not run in a follow-on", () => {
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["pr", "head", "digest", "wave", "commit"]);
    expect(doc.jobs["wave-1-layer-1-plan"]!.if).toBe("${{ github.event.inputs.wave == '' }}");
    expect(doc.jobs["wave-2-rest-plan"]!.env).toMatchObject({ CHANT_WAVES_WAVE: "${{ github.event.inputs.wave || '2' }}" });
  });

  test("the rest wave's record job dispatches the follow-on with the CHANT_FORGE_TOKEN secret, in its command's step alone", () => {
    const record = doc.jobs["wave-2-rest-record"]!;
    const command = record.steps.find((s) => s.name === "Write wave 2 (rest)'s run records")!;
    expect(JSON.parse(command.env!.CHANT_WAVES_FOLLOW_ON!)).toEqual({ forge: "forgejo", workflow: "tf-apply.yml" });
    expect(command.env!.CHANT_WAVES_FOLLOW_ON_TOKEN).toBe("${{ secrets.CHANT_FORGE_TOKEN }}");
    expect(JSON.stringify(record.env ?? {})).not.toContain("CHANT_FORGE_TOKEN");
    expect(record.steps.find((s) => s.name === "Keep the rest wave's note")!.with).toMatchObject({ path: ".chant/op-waves/tf-apply/outcomes/rest-wave.json" });
    // The record job keeps the applying job's handed files at the wave's paths.
    expect(record.steps.find((s) => s.name === "Keep the apply job of wave 2 (rest) of tf-apply's outcome and run record")!.with).toMatchObject({
      path: ".chant/op-waves/tf-apply/outcomes/outcome-wave-${{ env.CHANT_WAVES_WAVE }}-apply.json\n.chant/op-waves/tf-apply/outcomes/run-record-wave-${{ env.CHANT_WAVES_WAVE }}.json\n",
    });
  });

  test("the hand-off round-trips at the wave the follow-on names", () => {
    const planJob = mkdtempSync(join(tmpdir(), "forgejo-follow-on-plan-"));
    const gateJob = mkdtempSync(join(tmpdir(), "forgejo-follow-on-gate-"));
    const put = (root: string, path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put(planJob, ".chant/op-waves/tf-apply/wave-4/saved-plan.json", '{"version":1,"wave":4}');
    put(planJob, ".chant/op-waves/tf-apply/outcomes/outcome-wave-4.json", '{"members":{}}');
    // Wave 2's files, which a follow-on for wave 4 does not hand on.
    put(planJob, ".chant/op-waves/tf-apply/wave-2/saved-plan.json", '{"version":1,"wave":2}');
    const plan = doc.jobs["wave-2-rest-plan"]!.steps.at(-1)!.run!;
    expect(plan).toContain(`for p in '.chant/op-waves/tf-apply/wave-'"$CHANT_WAVES_WAVE"'' '.chant/op-waves/tf-apply/outcomes/outcome-wave-'"$CHANT_WAVES_WAVE"'.json'`);
    writeFileSync(join(planJob, "step.sh"), plan);
    const output = join(planJob, "github-output");
    execFileSync("sh", ["-e", join(planJob, "step.sh")], { cwd: planJob, env: { PATH: process.env.PATH!, GITHUB_OUTPUT: output, CHANT_WAVES_WAVE: "4" }, stdio: "pipe" });
    const outputs = Object.fromEntries(readFileSync(output, "utf-8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const take = doc.jobs["wave-2-rest-gate"]!.steps.find((s) => s.name === "Take the plan job of wave 2 (rest) of tf-apply's files from its outputs")!.run!;
    const filled = take.replace(/\$\{\{ toJSON\(needs\.wave-2-rest-plan\.outputs\.(report_\d)\) \}\}/g, (_, k: string) => JSON.stringify(outputs[k] ?? ""));
    writeFileSync(join(gateJob, "step.sh"), filled);
    execFileSync("sh", ["-e", join(gateJob, "step.sh")], { cwd: gateJob, env: { PATH: process.env.PATH!, CHANT_WAVES_WAVE: "4" }, stdio: "pipe" });
    expect(readFileSync(join(gateJob, ".chant/op-waves/tf-apply/wave-4/saved-plan.json"), "utf-8")).toBe('{"version":1,"wave":4}');
    expect(readFileSync(join(gateJob, ".chant/op-waves/tf-apply/outcomes/outcome-wave-4.json"), "utf-8")).toBe('{"members":{}}');
    expect(() => readFileSync(join(gateJob, ".chant/op-waves/tf-apply/wave-2/saved-plan.json"))).toThrow();
  });
});
