/**
 * #4984 on Forgejo: the waves workflow's before-merge mode, through the
 * GitHub-shaped doc and Forgejo's dialect. The dispatch carries the decided
 * head, the guard reads the decision, and a merge needs a token of its own,
 * since Forgejo refuses a merge made with the job's.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "dev" }] }, { name: "prod", runs: [{ target: "prod" }] }],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci" };

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Doc = { on: { workflow_dispatch?: { inputs?: Record<string, unknown> } }; jobs: Record<string, { needs?: string[]; env?: Record<string, string>; steps: Step[] }> };
const docOf = (o: Record<string, unknown>): Doc => parseYAML(generateForgejoOpWavesPipeline(spec, { ...options, ...o }).files[0]!.yaml) as Doc;

describe("the before-merge mode on Forgejo (#4984)", () => {
  test("the dispatch carries the decided head, and the guard reads the decision for op tf-apply", () => {
    const doc = docOf({ beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN" } });
    expect(Object.keys(doc.on.workflow_dispatch!.inputs!)).toEqual(["pr", "head", "digest"]);
    const wave = doc.jobs["wave-1-dev"]!;
    expect(JSON.parse(wave.steps[0]!.env!.CHANT_JOB_GUARD!)).toMatchObject({ forge: "forgejo", beforeMerge: { op: "tf-apply" } });
    expect(wave.steps.some((s) => s.name === "Check out the pull request's decided head" && s.run!.includes("refs/pull/${CHANT_BEFORE_MERGE_PR}/head"))).toBe(true);
    const done = doc.jobs["before-merge-done"]!;
    expect(done.needs).toEqual(["wave-2-prod"]);
    expect(done.steps.at(-1)!.run).toBe("terragucci run wave --op tf-apply --wave 2 --merge auto --forge forgejo --merge-token-env CHANT_MERGE_TOKEN");
  });

  test("merge auto needs the merge token's secret", () => {
    expect(() => docOf({ beforeMerge: { merge: "auto" } })).toThrow("beforeMerge.merge auto on forgejo needs mergeTokenSecret: Forgejo refuses a merge made with the job's own token");
    expect(() => docOf({ beforeMerge: { merge: "manual" } })).not.toThrow();
  });
});
