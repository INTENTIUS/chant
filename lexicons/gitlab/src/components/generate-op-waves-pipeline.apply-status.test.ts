/**
 * #4987 on GitLab: a job in each wave's stage posts its apply status from
 * the outcome files, whatever the wave ended, and none of the change's code
 * runs there; a push's pipeline marks stale plan notes beside wave 1.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }] },
  ],
} as OpWavesSpec;
const stale = { command: 'terragucci components pr-post --stale --tip "$TIP_SHA" --env default --forge gitlab --member dev --member prod', env: { TIP_SHA: "$CI_COMMIT_SHA" } };
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", applyStatus: { context: "terragucci/apply" }, staleNotes: stale };

type Job = { stage: string; needs?: string[]; rules: Array<{ if: string; when?: string }>; variables?: Record<string, string>; script: string[]; allow_failure?: unknown };
const docOf = (o: Record<string, unknown> = {}) => parseYAML(generateGitlabOpWavesPipeline(spec, { ...options, ...o } as never).files[0]!.yaml) as Record<string, Job> & { stages: string[] };

describe("the apply statuses on GitLab (#4987)", () => {
  const doc = docOf({ beforeMerge: {} });

  test("a job in each wave's stage needs the wave's jobs and runs whatever they ended", () => {
    expect(doc["apply-status-1"]!.stage).toBe("wave-1-dev");
    expect(doc["apply-status-1"]!.needs).toEqual(["wave-1-dev"]);
    expect(doc["apply-status-2"]!.stage).toBe("wave-2-prod");
    expect(doc["apply-status-2"]!.needs).toEqual(["wave-2-prod"]);
    // The push's pipeline and the before-merge pipeline, each always.
    expect(doc["apply-status-2"]!.rules.map((r) => r.when)).toEqual(["always", "always"]);
    expect(doc["apply-status-2"]!.rules.map((r) => r.if)).toEqual(doc["wave-2-prod"]!.rules.map((r) => r.if));
    expect(doc["apply-status-2"]!.allow_failure).toBe(true);
  });

  test("it posts on the decided head or the pushed commit, and never checks out the merge request's head", () => {
    const script = doc["apply-status-2"]!.script;
    expect(script.at(-1)).toBe('terragucci run wave --op tf-apply --wave 2 --of 2 --apply-status terragucci/apply --at "${CHANT_BEFORE_MERGE_HEAD:-$CI_COMMIT_SHA}" --forge gitlab');
    expect(script.join("\n")).not.toContain("refs/merge-requests/");
    expect(docOf()["apply-status-1"]!.script.at(-1)).toContain('--at "$CI_COMMIT_SHA"');
  });

  test("a push's pipeline marks the stale plan notes beside wave 1; a before-merge pipeline does not", () => {
    const job = doc["stale-notes"]!;
    expect(job.stage).toBe("wave-1-dev");
    expect(job.needs).toBeUndefined();
    expect(job.rules).toHaveLength(1);
    expect(job.rules[0]!.if).toContain('$CI_PIPELINE_SOURCE == "push"');
    expect(job.variables).toEqual({ TIP_SHA: "$CI_COMMIT_SHA" });
    expect(job.script.at(-1)).toBe(stale.command);
  });

  test("without them, neither job", () => {
    const none = docOf({ applyStatus: undefined, staleNotes: undefined });
    expect(Object.keys(none).filter((j) => j.startsWith("apply-status") || j === "stale-notes")).toEqual([]);
  });
});
