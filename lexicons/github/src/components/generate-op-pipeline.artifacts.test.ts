/** #4622: a scheduled Op's job keeps named artifacts after its run. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpPipeline } from "./generate-op-pipeline";
import { UPLOAD_ARTIFACT } from "./ci-jobs";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

type Step = { if?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const steps = (yaml: string, job: string): Step[] => (parseYAML(yaml) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]!.steps;
const drift: ScheduledOpSpec = { name: "drift", schedule: "0 6 * * *", artifacts: [{ name: "drift-report", paths: ["reports/", "summary.md"], retentionDays: 14 }] };

describe("scheduled Op artifacts on GitHub (#4622)", () => {
  test("each artifact is an upload after the run, kept whatever the run ended with", () => {
    const s = steps(generateGithubOpPipeline([drift]).files[0]!.yaml, "drift");
    const run = s.findIndex((x) => x.run?.includes("chant run drift"));
    const up = s.findIndex((x) => x.uses === UPLOAD_ARTIFACT);
    expect(run).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(run);
    const { path, ...rest } = s[up]!.with!;
    expect({ ...s[up], with: rest }).toEqual({
      if: "always()",
      uses: UPLOAD_ARTIFACT,
      with: { name: "drift-report", "if-no-files-found": "ignore", "retention-days": 14 },
    });
    expect(String(path).trimEnd().split("\n")).toEqual(["reports/", "summary.md"]);
  });

  test("two artifacts are two uploads, and no retention leaves the forge's", () => {
    const spec: ScheduledOpSpec = { name: "audit", schedule: "0 6 * * *", artifacts: [{ name: "a", paths: ["a.json"] }, { name: "b", paths: ["b/"] }] };
    const ups = steps(generateGithubOpPipeline([spec]).files[0]!.yaml, "audit").filter((x) => x.uses === UPLOAD_ARTIFACT);
    expect(ups.map((u) => u.with)).toEqual([
      { name: "a", path: "a.json", "if-no-files-found": "ignore" },
      { name: "b", path: "b/", "if-no-files-found": "ignore" },
    ]);
  });

  test("a workspace member's paths are read from its directory", () => {
    const yaml = generateGithubOpPipeline([drift], { member: { name: "app", dir: "stacks/app" } }).files[0]!.yaml;
    const doc = parseYAML(yaml) as { jobs: Record<string, { steps: Step[] }> };
    const [job] = Object.values(doc.jobs);
    const up = job!.steps.find((x) => x.uses === UPLOAD_ARTIFACT)!;
    expect(String(up.with!.path).trimEnd().split("\n")).toEqual(["stacks/app/reports", "stacks/app/summary.md"]);
  });

  test("an Op with no artifacts has no upload, as before", () => {
    const s = steps(generateGithubOpPipeline([{ name: "drift", schedule: "0 6 * * *" }]).files[0]!.yaml, "drift");
    expect(s.some((x) => x.uses === UPLOAD_ARTIFACT)).toBe(false);
  });

  test("bad artifacts are refused by name", () => {
    const gen = (artifacts: ScheduledOpSpec["artifacts"], extra: Partial<ScheduledOpSpec> = {}) => () =>
      generateGithubOpPipeline([{ name: "drift", schedule: "0 6 * * *", artifacts, ...extra }]);
    expect(gen([{ name: "a", paths: ["x"] }, { name: "a", paths: ["y"] }])).toThrow(/names the artifact "a" twice/);
    expect(gen([{ name: "a", paths: [] }])).toThrow(/lists no paths/);
    expect(gen([{ name: "a", paths: ["../secrets"] }])).toThrow(/not a path inside the job's directory/);
    expect(gen([{ name: "a", paths: ["/etc"] }])).toThrow(/not a path inside the job's directory/);
    expect(gen([{ name: "a b", paths: ["x"] }])).toThrow(/letters, digits/);
    expect(gen([{ name: "a", paths: ["x"], retentionDays: 0 }])).toThrow(/retentionDays/);
    expect(gen([{ name: "a", paths: ["x"] }], { trigger: { kind: "pull_request" }, reviewAgent: true })).toThrow(/reviewAgent split or a comment agent/);
  });
});
