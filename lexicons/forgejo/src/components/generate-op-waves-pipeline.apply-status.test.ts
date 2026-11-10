/**
 * #4987 on Forgejo: the same apply status jobs and stale marking job as on
 * GitHub, in Forgejo's dialect, posting with Forgejo as the forge.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  // #4987: a spec with `step` cannot split before merge, so these waves plan and apply with commands.
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "dev", runs: [{ target: "dev" }] }, { name: "prod", runs: [{ target: "prod" }] }],
} as OpWavesSpec;
const stale = { command: 'chant components pr-post --stale --tip "$TIP_SHA" --env default --forge forgejo --member dev', env: { TIP_SHA: "${{ github.sha }}", GITHUB_TOKEN: "${{ github.token }}" } };

type Job = { needs?: string[]; if?: string; env?: Record<string, string>; steps: Array<{ run?: string; env?: Record<string, string> }> };

describe("the apply statuses on Forgejo (#4987)", () => {
  const yaml = generateForgejoOpWavesPipeline(spec, { specFile: ".chant/op-waves/tf-apply.spec.json", applyStatus: { context: "terragucci/apply" }, staleNotes: stale, beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN" } }).files[0]!.yaml;
  const { jobs } = parseYAML(yaml) as { jobs: Record<string, Job> };

  test("a job after each wave posts on the decided head or the push's commit, with forgejo as the forge", () => {
    expect(jobs["apply-status-1"]!.needs).toEqual(["wave-1-dev-plan", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record"]);
    expect(jobs["apply-status-2"]!.steps.at(-1)!.run).toBe('chant run wave --op tf-apply --wave 2 --of 2 --apply-status terragucci/apply --at "${CHANT_BEFORE_MERGE_HEAD:-$GITHUB_SHA}" --forge forgejo');
    expect(JSON.stringify(jobs["apply-status-2"]!.steps)).not.toContain("refs/pull/");
  });

  test("the stale marking job runs on a push alone", () => {
    expect(jobs["stale-notes"]!.if).toBe("${{ github.event_name == 'push' }}");
    expect(jobs["stale-notes"]!.steps.at(-1)!.run).toBe(stale.command);
  });
});
