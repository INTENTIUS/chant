/**
 * #4987 on GitHub: the apply statuses come from a job after each wave that
 * runs none of the change's code, and a push marks stale plan notes from a
 * job beside wave 1.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  // #4987: a spec with `step` cannot split before merge, so these waves plan and apply with commands.
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }], environment: { name: "prod" } },
  ],
} as OpWavesSpec;
const stale = { command: 'npx --no-install terragucci components pr-post --stale --tip "$TIP_SHA" --env default --forge github --member dev --member prod', env: { TIP_SHA: "${{ github.sha }}", GITHUB_TOKEN: "${{ github.token }}" } };
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "npx --no-install terragucci", applyStatus: { context: "terragucci/apply" }, staleNotes: stale };

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string };
type Job = { needs?: string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
const docOf = (o: Record<string, unknown> = {}) => parseYAML(generateGithubOpWavesPipeline(spec, { ...options, ...o } as never).files[0]!.yaml) as { jobs: Record<string, Job> };

describe("the apply statuses on GitHub (#4987)", () => {
  const { jobs } = docOf();

  test("a job after each wave, whatever the wave did, posts the status on the push's commit", () => {
    expect(jobs["apply-status-1"]!.needs).toEqual(["wave-1-dev"]);
    expect(jobs["apply-status-2"]!.needs).toEqual(["wave-2-prod"]);
    for (const k of [1, 2]) {
      const job = jobs[`apply-status-${k}`]!;
      expect(job.if).toBe("${{ !cancelled() }}");
      expect(job.permissions).toEqual({ contents: "read", statuses: "write" });
      const post = job.steps.at(-1)!;
      expect(post.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
      expect(post.run).toBe(`npx --no-install terragucci run wave --op tf-apply --wave ${k} --of 2 --apply-status terragucci/apply --at "$GITHUB_SHA" --forge github`);
    }
  });

  test("the status job runs none of the change's code: it never checks out the pull request's head", () => {
    const { jobs: bm } = docOf({ beforeMerge: {} });
    const job = bm["apply-status-2"]!;
    expect(JSON.stringify(job.steps)).not.toContain("refs/pull/");
    expect(JSON.stringify(job.steps)).not.toContain('git checkout -q --detach \\"$CHANT_BEFORE_MERGE_HEAD\\"');
    // Before merge it posts on the decided head, which the dispatch carries, after each of the wave's split jobs (#4987).
    expect(job.env).toMatchObject({ CHANT_BEFORE_MERGE_HEAD: "${{ github.event.inputs.head }}" });
    expect(job.steps.at(-1)!.run).toContain('--at "${CHANT_BEFORE_MERGE_HEAD:-$GITHUB_SHA}"');
    expect(job.needs).toEqual(["wave-2-prod-plan", "wave-2-prod-gate", "wave-2-prod", "wave-2-prod-record"]);
    // The wave jobs post no status of their own.
    expect(bm["wave-1-dev"]!.permissions?.statuses).toBeUndefined();
  });

  test("a push marks the stale plan notes beside wave 1, never a dispatch", () => {
    const job = jobs["stale-notes"]!;
    expect(job.needs).toBeUndefined();
    expect(job.if).toBe("${{ github.event_name == 'push' }}");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "write", statuses: "write" });
    expect(job.steps.at(-1)).toEqual({ name: "Mark the plan notes this push made stale", env: stale.env, run: stale.command });
  });

  test("without them, no status job and no stale job", () => {
    const { jobs: none } = docOf({ applyStatus: undefined, staleNotes: undefined });
    expect(Object.keys(none).filter((j) => j.startsWith("apply-status") || j === "stale-notes")).toEqual([]);
  });

  test("a context that is not a status name is refused", () => {
    expect(() => docOf({ applyStatus: { context: "terragucci apply" } })).toThrow("is not a status name");
  });
});
