/**
 * #5032: on Forgejo the first wave's jobs can need jobs of the product's
 * own workflow, such as terragucci's `check`, as on GitHub.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true },
  ],
} as unknown as OpWavesSpec;

describe("the first wave needs the product's jobs on Forgejo (#5032)", () => {
  test("wave 1's job needs check, and runs only when it passed", () => {
    const options = { specFile: "w.json", runIf: "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)", firstWaveNeeds: ["check"] };
    const jobs = buildForgejoOpWavesDoc(spec, options).doc.jobsDoc as Record<string, { needs?: string[]; if?: string }>;
    expect(jobs["wave-1-canary"]!.needs).toEqual(["check"]);
    expect(jobs["wave-1-canary"]!.if).toContain("needs.check.result == 'success'");
    expect(jobs["wave-2-wide"]!.needs).toEqual(["wave-1-canary"]);
    const before = buildForgejoOpWavesDoc(spec, { ...options, beforeMerge: { merge: "manual" } }).doc.jobsDoc as Record<string, { needs?: string[] }>;
    expect(before["wave-1-canary-plan"]!.needs).toEqual(["check"]);
  });
});
