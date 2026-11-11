/**
 * #4992 on GitHub: a split pipeline's `rest` wave runs one wave per run.
 * The workflow takes `wave` and `commit`; the jobs of the waves before the
 * rest wave do not run in a follow-on; the rest wave's jobs run the wave
 * the run names and keep their files at that wave's paths; its record job
 * dispatches the follow-on with the job's token, and the jobs after the
 * waves read the note it leaves.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  control: { repo: "github.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "layer-1", runs: [], discover: true },
    { name: "layer-2", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "auto" as const }, applyStatus: { context: "terragucci/apply" }, evidence: { identity: "oidc" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; env?: Record<string, string>; permissions?: Record<string, string>; steps: Step[] };
type Doc = { on: { workflow_dispatch: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };

const docOf = (s: OpWavesSpec = spec, o: Record<string, unknown> = {}): Doc => parseYAML(generateGithubOpWavesPipeline(s, { ...options, ...o } as never).files[0]!.yaml) as Doc;
const step = (job: Job, name: string): Step => job.steps.find((s) => s.name === name)!;
const W = "${{ env.CHANT_WAVES_WAVE }}";

describe("a rest wave before merge on GitHub runs one wave per run (#4992)", () => {
  const doc = docOf();

  test("the workflow takes the follow-on's wave and a push's commit beside the decision", () => {
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["pr", "head", "digest", "wave", "commit"]);
  });

  test("the jobs of the waves before the rest wave do not run in a follow-on", () => {
    expect(doc.jobs["wave-1-layer-1-plan"]!.if).toBe("${{ github.event.inputs.wave == '' }}");
    expect(doc.jobs["wave-1-layer-1-gate"]!.if).toBe("${{ (!cancelled()) && github.event.inputs.wave == '' }}");
    expect(doc.jobs["wave-2-layer-2-record"]!.if).toBe("${{ (!cancelled() && !contains(needs.*.result, 'skipped')) && github.event.inputs.wave == '' }}");
    expect(doc.jobs["wave-2-layer-2-plan-evidence"]!.if).toBe("${{ (!cancelled()) && github.event.inputs.wave == '' }}");
    expect(doc.jobs["apply-status-2"]!.if).toBe("${{ (!cancelled()) && github.event.inputs.wave == '' }}");
    // The rest wave's plan job still runs after the record job it needs was skipped.
    expect(doc.jobs["wave-3-rest-plan"]!.if).toBe("!cancelled()");
    expect(doc.jobs["apply-status-3"]!.if).toBe("${{ !cancelled() }}");
  });

  test("the rest wave's jobs run the wave the run names, and keep its files at that wave's paths", () => {
    for (const name of ["wave-3-rest-plan", "wave-3-rest-gate", "wave-3-rest", "wave-3-rest-record"]) {
      const job = doc.jobs[name]!;
      expect(job.env).toMatchObject({ CHANT_WAVES_WAVE: "${{ github.event.inputs.wave || '3' }}", CHANT_WAVES_COMMIT: "${{ github.event.inputs.commit }}" });
      expect(JSON.parse(job.steps[0]!.env!.CHANT_JOB_GUARD!).rest).toBe(3);
      expect(job.steps.some((s) => s.run?.includes('--wave "${CHANT_WAVES_WAVE:-3}"')), name).toBe(true);
    }
    expect(doc.jobs["wave-2-layer-2-plan"]!.env?.CHANT_WAVES_WAVE).toBeUndefined();
    expect(JSON.parse(doc.jobs["wave-2-layer-2-plan"]!.steps[0]!.env!.CHANT_JOB_GUARD!).rest).toBeUndefined();
    expect(step(doc.jobs["wave-3-rest-plan"]!, "Keep wave 3's saved plan").with).toMatchObject({ name: "tf-apply-wave-3-plan", path: `.chant/op-waves/tf-apply/wave-${W}` });
    expect(step(doc.jobs["wave-3-rest-gate"]!, "Keep wave 3's decision").with).toMatchObject({ path: `.chant/op-waves/tf-apply/wave-${W}.json` });
    expect(step(doc.jobs["wave-3-rest-gate"]!, "Keep the job's outcome").with).toMatchObject({ path: `.chant/op-waves/tf-apply/outcomes/outcome-wave-${W}.json` });
    expect(step(doc.jobs["wave-3-rest"]!, "Keep the job's outcome and run record").with!.path).toBe(`.chant/op-waves/tf-apply/outcomes/outcome-wave-${W}-apply.json\n.chant/op-waves/tf-apply/outcomes/run-record-wave-${W}.json\n`);
    // The waves before it keep their own paths.
    expect(step(doc.jobs["wave-2-layer-2-plan"]!, "Keep wave 2's saved plan").with).toMatchObject({ path: ".chant/op-waves/tf-apply/wave-2" });
  });

  test("a push's follow-on checks out the commit it goes on with in every job of the rest wave", () => {
    const check = 'git merge-base --is-ancestor "$CHANT_WAVES_COMMIT" HEAD';
    expect(doc.jobs["wave-3-rest-plan"]!.steps[1]!.run).toContain(check);
    expect(doc.jobs["wave-3-rest"]!.steps[1]!.run).toContain(check);
    expect(step(doc.jobs["wave-3-rest-gate"]!, "Check out the commit a push's follow-on goes on with").run).toContain(check);
    expect(step(doc.jobs["wave-3-rest-record"]!, "Check out the commit a push's follow-on goes on with").run).toContain(check);
    expect(step(doc.jobs["wave-3-rest-plan-evidence"]!, "Check out the base, so none of the change's code runs here").run).toContain(check);
    expect(doc.jobs["wave-3-rest-plan-evidence"]!.steps.at(-1)!.run).toContain('--at "${CHANT_BEFORE_MERGE_HEAD:-${CHANT_WAVES_COMMIT:-$GITHUB_SHA}}"');
    // The guard (the first step) reads the variables in every job; no other step of a wave before the rest wave does.
    expect(JSON.stringify(doc.jobs["wave-2-layer-2-plan"]!.steps.slice(1))).not.toContain("CHANT_WAVES_COMMIT");
  });

  test("the rest wave's record job dispatches the follow-on with the job's token, in its own step, and keeps the note", () => {
    const record = doc.jobs["wave-3-rest-record"]!;
    expect(record.permissions).toEqual({ contents: "write", actions: "write" });
    const command = step(record, "Write wave 3 (rest)'s run records");
    expect(JSON.parse(command.env!.CHANT_WAVES_FOLLOW_ON!)).toEqual({ forge: "github", workflow: "tf-apply.yml" });
    expect(command.env!.CHANT_WAVES_FOLLOW_ON_TOKEN).toBe("${{ github.token }}");
    expect(step(record, "Keep the rest wave's note").with).toMatchObject({ name: "tf-apply-wave-3-rest-record-outcome", path: ".chant/op-waves/tf-apply/outcomes/rest-wave.json" });
    // No other record job may dispatch.
    expect(doc.jobs["wave-2-layer-2-record"]!.permissions).toEqual({ contents: "write" });
    expect(JSON.stringify(doc.jobs["wave-2-layer-2-record"]!.steps)).not.toContain("CHANT_WAVES_FOLLOW_ON");
  });

  test("the jobs after the waves treat a run that started a follow-on as not the last", () => {
    // before-merge-done reads the last wave's own result, since a follow-on skipped the waves before it.
    expect(doc.jobs["before-merge-done"]!.if).toBe("${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'skipped') && github.event.inputs.head != '' }}");
    const status = doc.jobs["apply-status-3"]!;
    expect(status.env).toMatchObject({ CHANT_WAVES_WAVE: "${{ github.event.inputs.wave || '3' }}" });
    expect(step(status, "Post terragucci/apply after wave 3").run).toBe('terragucci run wave --op tf-apply --wave "${CHANT_WAVES_WAVE:-3}" --of 3 --apply-status terragucci/apply --at "${CHANT_BEFORE_MERGE_HEAD:-${CHANT_WAVES_COMMIT:-$GITHUB_SHA}}" --forge github');
    expect(step(doc.jobs["apply-status-2"]!, "Post terragucci/apply after wave 2").run).toContain('--wave 2 --of 3 --apply-status terragucci/apply --at "${CHANT_BEFORE_MERGE_HEAD:-$GITHUB_SHA}"');
    const control = doc.jobs["control-dispatch"]!;
    const send = control.steps.at(-1)!;
    expect(send.run!.split("\n")[0]).toBe('if [ -z "${CHANT_CONTROL_OUTCOME:-}" ]; then echo "chant: this run started a follow-on run for the next wave, which tells the control repo how the waves ended"; exit 0; fi');
    expect(send.env!.CHANT_CONTROL_SHA).toBe("${{ github.event.inputs.commit || github.sha }}");
  });

  test("a pipeline without a rest wave, or without beforeMerge, renders none of it", () => {
    const plain = docOf({ ...spec, waves: spec.waves.slice(0, 2) } as OpWavesSpec);
    expect(Object.keys(plain.on.workflow_dispatch.inputs)).toEqual(["pr", "head", "digest"]);
    const unguarded = (d: Doc) => JSON.stringify(Object.values(d.jobs).map((j) => ({ ...j, steps: j.steps.filter((s) => !s.env?.CHANT_JOB_GUARD) })));
    expect(unguarded(plain)).not.toMatch(/CHANT_WAVES_(WAVE|COMMIT|FOLLOW_ON)/);
    expect(plain.jobs["before-merge-done"]!.if).toBe("${{ success() && github.event.inputs.head != '' }}");
    const push = parseYAML(generateGithubOpWavesPipeline(spec, { ...options, beforeMerge: undefined } as never).files[0]!.yaml) as Doc;
    expect(unguarded(push)).not.toMatch(/CHANT_WAVES_(WAVE|COMMIT|FOLLOW_ON)/);
  });
});
