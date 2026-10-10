import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "a" }, { target: "b" }], gate: "on-destructive", shares: 2, environment: { name: "production" } },
  ],
};

describe("generateGithubOpWavesPipeline", () => {
  test("one workflow; each wave needs the one before, and a wide wave hands its decision to its shares", () => {
    const { files, jobs } = generateGithubOpWavesPipeline(spec, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual(["migrations.yml"]);
    expect(jobs.map((j) => j.jobName)).toEqual(["wave-1-dev", "wave-2-prod-decide", "wave-2-prod-share-1", "wave-2-prod-share-2"]);
    const yaml = files[0]!.yaml;
    expect(yaml).toContain("push:\n    branches:\n      - main");
    expect(yaml).toContain("permissions:\n  contents: write");
    expect(yaml).toContain("fetch-depth: 0");
    expect(yaml).toContain("run: chant run wave --spec waves.json --wave 1\n");
    expect(yaml).toMatch(/wave-2-prod-decide:\n\s+runs-on: ubuntu-latest\n\s+needs:\n\s+- wave-1-dev/);
    expect(yaml).toContain("run: chant run wave --spec waves.json --wave 2 --decide");
    expect(yaml).toMatch(/wave-2-prod-share-2:\n\s+runs-on: ubuntu-latest\n\s+needs:\n\s+- wave-2-prod-decide/);
    expect(yaml).toContain("run: chant run wave --spec waves.json --wave 2 --share 2");
    expect(yaml).toContain("uses: actions/upload-artifact@v4");
    expect(yaml).toContain("name: migrations-wave-2-decision");
    expect(yaml).toContain("environment:\n      name: production");
  });

  test("resume renders a scheduled workflow that re-runs approved waves with actions: write (#3683)", () => {
    const { files } = generateGithubOpWavesPipeline({ ...spec, resume: { schedule: "*/10 * * * *" } }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual([`${spec.name}.yml`, `${spec.name}-resume.yml`]);
    const yaml = files[1]!.yaml;
    expect(yaml).toContain("- cron: '*/10 * * * *'");
    expect(yaml).toMatch(/permissions:\n\s+contents: read\n\s+actions: write/);
    expect(yaml).toContain(`run: chant run resume --op ${spec.name}`);
    expect(yaml).toContain("GITHUB_TOKEN: '${{ github.token }}'");
    expect(generateGithubOpWavesPipeline(spec, { specFile: "waves.json" }).files).toHaveLength(1);
  });

  test("a pr-review wave adds a pull request workflow that records the head's plans (#3684)", () => {
    const { files } = generateGithubOpWavesPipeline({ ...spec, waves: spec.waves.map((w, i) => (i === spec.waves.length - 1 ? { ...w, approval: "pr-review" as const } : w)) }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual([`${spec.name}.yml`, `${spec.name}-plans.yml`]);
    expect(files[1]!.yaml).toContain("pull_request:");
    expect(files[1]!.yaml).toContain("run: chant run wave --spec waves.json --record-plans");
    expect(files[0]!.yaml).toMatch(/permissions:\n\s+contents: write\n\s+pull-requests: read/);
  });
});
