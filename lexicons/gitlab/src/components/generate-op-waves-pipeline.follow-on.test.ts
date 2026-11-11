/**
 * #4992 on GitLab: a split pipeline's `rest` wave runs one wave per
 * pipeline. A follow-on pipeline leaves out the jobs of the waves before
 * the rest wave, whose needs on them are optional; the rest wave's jobs run
 * the wave `CHANT_WAVES_WAVE` names (their own by default), keep its files
 * at that wave's paths and also run in a push's follow-on pipeline; the
 * record job starts the follow-on; the status and control jobs read the
 * note it leaves.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline, gitlabFollowOnRule } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "layer-1", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" as const }, applyStatus: { context: "terragucci/apply" }, evidence: { identity: "oidc" as const } };

type Rule = { if: string; when?: string };
type Job = { needs?: Array<string | { job: string; optional: boolean }>; rules?: Rule[]; variables?: Record<string, string>; script?: string[]; artifacts?: { paths?: string[] } };
const docOf = (s: OpWavesSpec = spec): Record<string, Job> => parseYAML(generateGitlabOpWavesPipeline(s, options as never).files[0]!.yaml) as Record<string, Job>;

describe("a rest wave before merge on GitLab runs one wave per pipeline (#4992)", () => {
  const doc = docOf();
  const follow = gitlabFollowOnRule('"main"');

  test("a follow-on pipeline leaves out the waves before the rest wave", () => {
    for (const name of ["wave-1-layer-1-plan", "wave-1-layer-1-gate", "wave-1-layer-1", "wave-1-layer-1-record", "wave-1-layer-1-plan-evidence", "apply-status-1"]) {
      expect(doc[name]!.rules![0], name).toEqual({ if: "$CHANT_WAVES_WAVE", when: "never" });
    }
    expect(doc["wave-2-rest-plan"]!.rules!.some((r) => r.when === "never")).toBe(false);
    // The rest wave's needs on the waves before it are optional, since a follow-on pipeline has none of those jobs.
    expect(doc["wave-2-rest-plan"]!.needs).toEqual([{ job: "wave-1-layer-1-record", optional: true }]);
    expect(doc["wave-2-rest-gate"]!.needs).toEqual(["wave-2-rest-plan"]);
  });

  test("the rest wave's jobs run the wave the pipeline names, keep its files at that wave's paths, and run in a push's follow-on", () => {
    for (const name of ["wave-2-rest-plan", "wave-2-rest-gate", "wave-2-rest", "wave-2-rest-record"]) {
      const job = doc[name]!;
      expect(job.variables!.CHANT_WAVES_WAVE, name).toBe("2");
      expect(JSON.parse(job.variables!.CHANT_JOB_GUARD!).rest, name).toBe(2);
      expect(job.rules!.map((r) => r.if), name).toContain(follow);
      expect(job.script!.some((l) => l.includes('--wave "${CHANT_WAVES_WAVE:-2}"')), name).toBe(true);
      expect(job.script!.some((l) => l.includes('git merge-base --is-ancestor "$CHANT_WAVES_COMMIT" HEAD')), name).toBe(true);
    }
    expect(doc["wave-2-rest-plan"]!.artifacts!.paths).toContain(".chant/op-waves/tf-apply/wave-$CHANT_WAVES_WAVE/");
    expect(doc["wave-2-rest-gate"]!.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/wave-$CHANT_WAVES_WAVE.json", ".chant/op-waves/tf-apply/wave-$CHANT_WAVES_WAVE/", ".chant/op-waves/tf-apply/outcomes/"]);
    // The waves before it keep their own paths and run in no follow-on.
    expect(doc["wave-1-layer-1-gate"]!.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/wave-1.json", ".chant/op-waves/tf-apply/wave-1/", ".chant/op-waves/tf-apply/outcomes/"]);
    expect(doc["wave-1-layer-1-plan"]!.rules!.map((r) => r.if)).not.toContain(follow);
    expect(doc["wave-1-layer-1-plan"]!.variables!.CHANT_WAVES_WAVE).toBeUndefined();
    // The evidence job signs at the commit a push's follow-on went on with.
    expect(doc["wave-2-rest-plan-evidence"]!.script!.at(-1)).toContain('--at "${CHANT_BEFORE_MERGE_HEAD:-${CHANT_WAVES_COMMIT:-$CI_COMMIT_SHA}}"');
  });

  test("the rest wave's record job starts the follow-on; no other job may", () => {
    expect(JSON.parse(doc["wave-2-rest-record"]!.variables!.CHANT_WAVES_FOLLOW_ON!)).toEqual({ forge: "gitlab" });
    expect(doc["wave-1-layer-1-record"]!.variables!.CHANT_WAVES_FOLLOW_ON).toBeUndefined();
    expect(doc["wave-2-rest-record"]!.artifacts!.paths).toEqual([".chant/op-waves/tf-apply/outcomes/"]);
  });

  test("the status and control jobs treat a pipeline that started a follow-on as not the last", () => {
    const status = doc["apply-status-2"]!;
    expect(status.variables!.CHANT_WAVES_WAVE).toBe("2");
    expect(status.rules).toContainEqual({ if: follow, when: "always" });
    expect(status.script!.at(-1)).toBe('terragucci run wave --op tf-apply --wave "${CHANT_WAVES_WAVE:-2}" --of 2 --apply-status terragucci/apply --at "${CHANT_BEFORE_MERGE_HEAD:-${CHANT_WAVES_COMMIT:-$CI_COMMIT_SHA}}" --forge gitlab');
    const control = doc["control-dispatch"]!;
    expect(control.rules!.map((r) => r.if)).toContain(follow);
    expect(control.script).toContain('if [ -z "${CHANT_CONTROL_OUTCOME:-}" ]; then echo "chant: this run started a follow-on run for the next wave, which tells the control repo how the waves ended"; exit 0; fi');
    expect(control.script).toContain('export CHANT_CONTROL_SHA="${CHANT_WAVES_COMMIT:-$CI_COMMIT_SHA}"');
    // before-merge-done runs in a before-merge pipeline alone, a follow-on of one included.
    expect(doc["before-merge-done"]!.rules!.map((r) => r.if)).not.toContain(follow);
  });

  test("a pipeline without a rest wave renders none of it", () => {
    const plain = docOf({ ...spec, waves: [spec.waves[0]!, { ...spec.waves[0]!, name: "layer-2" }] } as OpWavesSpec);
    // The guard's program, the first script line, reads the variables in every job; nothing else does.
    const unguarded = Object.values(plain).map((j) => (typeof j === "object" && j && !Array.isArray(j) ? { ...j, script: (j.script ?? []).filter((l) => !l.startsWith("(cd / && node -e")) } : j));
    expect(JSON.stringify(unguarded)).not.toMatch(/CHANT_WAVES_(WAVE|COMMIT|FOLLOW_ON)|"when":"never"/);
  });
});
