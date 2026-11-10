/**
 * #4984 on GitLab: the waves file's before-merge mode. The wave jobs also
 * run in an API, web or trigger pipeline of the default branch whose
 * `CHANT_BEFORE_MERGE_HEAD` is a sha (the note poll starts it); the guard
 * reads the decision, the script checks the head out after the guard and
 * the trade, and the done job runs after the last wave in that pipeline
 * alone. A push pipeline is as before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  // #4987: a spec with `step` cannot split before merge, so these waves plan and apply with commands.
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }], cloud },
  ],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci" };

type Job = { stage?: string; needs?: string[]; rules?: Array<{ if: string }>; variables?: Record<string, string>; script?: string[] };
const jobsOf = (o: Record<string, unknown>): Record<string, Job> => parseYAML(generateGitlabOpWavesPipeline(spec, { ...options, ...o }).files[0]!.yaml) as Record<string, Job>;

describe("the before-merge mode on GitLab (#4984)", () => {
  const jobs = jobsOf({ beforeMerge: { merge: "auto", mergeTokenSecret: "CHANT_MERGE_PAT" } });

  test("the wave jobs run on a push and in a pipeline started for a decided head", () => {
    expect(jobs["wave-1-dev"]!.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' },
      { if: '$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_BEFORE_MERGE_HEAD =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == "main"' },
    ]);
  });

  test("the guard reads the decision, and the head is checked out after the trade and before the setup", () => {
    const prod = jobs["wave-2-prod"]!;
    expect(JSON.parse(prod.variables!.CHANT_JOB_GUARD!)).toMatchObject({ forge: "gitlab", beforeMerge: { op: "tf-apply" } });
    const script = prod.script!;
    const head = script.findIndex((l) => l.includes("refs/merge-requests/${CHANT_BEFORE_MERGE_PR}/head"));
    const trade = script.findIndex((l) => l.includes("CHANT_CLOUD_TRADE") || l.includes("node -e"));
    expect(head).toBeGreaterThan(trade);
    expect(script[head]).toContain('CHANT_WAVES_BASE="$(git rev-parse HEAD)"; export CHANT_WAVES_BASE');
    const dev = jobs["wave-1-dev"]!.script!;
    expect(dev.findIndex((l) => l === "npm ci")).toBeGreaterThan(dev.findIndex((l) => l.includes("before-merge-head")));
    // #4987: the wave's own job applies the saved plan.
    expect(dev.at(-1)).toBe('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase apply');
  });

  test("the done job runs in a before-merge pipeline alone, after the last wave, with the merge token", () => {
    const done = jobs["before-merge-done"]!;
    expect(done.stage).toBe("before-merge-done");
    expect(done.needs).toEqual(["wave-2-prod-record"]);
    expect(done.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_BEFORE_MERGE_HEAD =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == "main"' }]);
    expect(done.variables).toEqual({ GIT_DEPTH: "0", CHANT_MERGE_TOKEN: "$CHANT_MERGE_PAT" });
    expect(done.script!.at(-1)).toBe("terragucci run wave --op tf-apply --wave 2 --merge auto --forge gitlab --merge-token-env CHANT_MERGE_TOKEN");
  });

  test("a wave's prelude goes in the script just before the command", () => {
    const script = jobsOf({ waveJobs: { dev: { before: [{ name: "login", run: ["login"] }], prelude: ["export TG_X=1"] } } })["wave-1-dev"]!.script!;
    expect(script.slice(-3)).toEqual(["login", "export TG_X=1", "terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1"]);
  });

  test("merge auto needs the merge token's variable, and without the mode nothing changes", () => {
    expect(() => jobsOf({ beforeMerge: { merge: "auto" } })).toThrow("GitLab's job token cannot merge");
    const push = jobsOf({});
    expect(push["before-merge-done"]).toBeUndefined();
    expect(push["wave-1-dev"]!.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' }]);
    expect(push["wave-1-dev"]!.script!.at(-1)).toBe("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1");
  });
});
