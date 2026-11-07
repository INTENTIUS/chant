/** #4622: a scheduled Op's job keeps named artifacts after its run, in the job's one archive. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

const job = (specs: ScheduledOpSpec[], name: string, options = {}) =>
  (parseYAML(generateGitlabOpPipeline(specs, options).files[0]!.yaml) as Record<string, Record<string, unknown>>)[name]!;

describe("scheduled Op artifacts on GitLab (#4622)", () => {
  test("one artifact is the job's archive, under its name, kept always", () => {
    const j = job([{ name: "drift", schedule: "0 6 * * *", artifacts: [{ name: "drift-report", paths: ["reports/", "summary.md"], retentionDays: 14 }] }], "drift");
    expect(j.artifacts).toEqual({ name: "drift-report", when: "always", paths: ["reports/", "summary.md"], expire_in: "14 days" });
  });

  test("several artifacts share the archive, kept as long as the longest asks", () => {
    const j = job([{ name: "audit", schedule: "0 6 * * *", artifacts: [{ name: "a", paths: ["a.json"], retentionDays: 3 }, { name: "b", paths: ["b/"], retentionDays: 30 }] }], "audit");
    expect(j.artifacts).toEqual({ when: "always", paths: ["a.json", "b/"], expire_in: "30 days" });
  });

  test("an entry with no retention leaves GitLab's default", () => {
    const j = job([{ name: "audit", schedule: "0 6 * * *", artifacts: [{ name: "a", paths: ["a.json"], retentionDays: 3 }, { name: "b", paths: ["b/"] }] }], "audit");
    expect(j.artifacts).not.toHaveProperty("expire_in");
  });

  test("a drift agent's flag stays in the archive beside the Op's artifacts", () => {
    const spec: ScheduledOpSpec = { name: "drift", trigger: { kind: "cron", schedule: "0 6 * * *" }, agent: { on: "drift", maxCostUsd: 4 }, artifacts: [{ name: "drift-report", paths: ["reports/"] }] };
    const without = job([{ ...spec, artifacts: undefined }], "drift").artifacts as Record<string, unknown>;
    const j = job([spec], "drift").artifacts as Record<string, unknown>;
    expect(j.reports).toEqual(without.reports);
    expect(j.paths).toEqual([...(without.paths as string[]), "reports/"]);
    expect(j.name).toBe("drift-report");
  });

  test("a workspace member's paths are read from its directory", () => {
    const out = parseYAML(generateGitlabOpPipeline([{ name: "drift", schedule: "0 6 * * *", artifacts: [{ name: "r", paths: ["reports/"] }] }], { member: { name: "app", dir: "stacks/app" } }).files[0]!.yaml) as Record<string, Record<string, unknown>>;
    const j = Object.values(out).find((v) => v && typeof v === "object" && "artifacts" in v)!;
    expect((j.artifacts as { paths: string[] }).paths).toEqual(["stacks/app/reports"]);
  });

  test("an Op with no artifacts has no archive, as before", () => {
    expect(job([{ name: "drift", schedule: "0 6 * * *" }], "drift")).not.toHaveProperty("artifacts");
  });
});
