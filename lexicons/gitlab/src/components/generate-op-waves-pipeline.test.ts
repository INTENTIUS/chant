import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "a" }, { target: "b" }], shares: 2, environment: { name: "production" } },
  ],
};

describe("generateGitlabOpWavesPipeline", () => {
  test("one stage per wave, needs chaining the waves, the decision kept as an artifact", () => {
    const { files } = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json" });
    expect(files[0]!.name).toBe("migrations.gitlab-ci.yml");
    const yaml = files[0]!.yaml;
    expect(yaml).toContain("stages:\n  - wave-1-dev\n  - wave-2-prod");
    expect(yaml).toContain(`if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"'`);
    expect(yaml).toContain("GIT_DEPTH: '0'");
    expect(yaml).toMatch(/wave-2-prod-decide:\n\s+stage: wave-2-prod[\s\S]*?needs:\n\s+- wave-1-dev/);
    expect(yaml).toContain("- chant run wave --spec waves.json --wave 2 --decide");
    expect(yaml).toMatch(/wave-2-prod-share-1:[\s\S]*?needs:\n\s+- wave-2-prod-decide/);
    expect(yaml).toContain("- .chant/op-waves/migrations/wave-2.json");
    expect(yaml).toContain("environment:\n    name: production");
  });

  test("resume renders a job that runs only in scheduled pipelines (#3683)", () => {
    const { files } = generateGitlabOpWavesPipeline({ ...spec, resume: { schedule: "*/10 * * * *" } }, { specFile: "waves.json" });
    const yaml = files[0]!.yaml;
    expect(yaml).toContain(`${spec.name}-resume:`);
    expect(yaml).toContain('$CI_PIPELINE_SOURCE == "schedule"');
    expect(yaml).toContain(`chant run resume --op ${spec.name}`);
    expect(yaml).toContain('give the schedule the cron "*/10 * * * *"');
    expect(generateGitlabOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml).not.toContain("resume");
  });

  test("a pr-review wave adds a merge request job that records the head's plans (#3684)", () => {
    const yaml = generateGitlabOpWavesPipeline({ ...spec, waves: spec.waves.map((w, i) => (i === spec.waves.length - 1 ? { ...w, approval: "pr-review" as const } : w)) }, { specFile: "waves.json" }).files[0]!.yaml;
    expect(yaml).toContain(`${spec.name}-record-plans:`);
    expect(yaml).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(yaml).toContain("chant run wave --spec waves.json --record-plans");
    expect(yaml).toMatch(/stages:\n\s+- plans\n/);
  });
});
