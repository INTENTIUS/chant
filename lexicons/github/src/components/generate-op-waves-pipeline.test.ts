import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";
import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";

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
    expect(yaml).toContain(`uses: ${usesRef(ACTION_PINS.uploadArtifact4)}`);
    expect(yaml).toContain("name: migrations-wave-2-decision");
    expect(yaml).toContain("environment:\n      name: production");
  });

  test("notify maps each variable it names from the secret of that name, and options.variables wins (#3761)", () => {
    const notify = { webhook: "CHANT_WEBHOOK", key: "CHANT_WEBHOOK_KEY", slack: "CHANT_SLACK_WEBHOOK" };
    const yaml = generateGithubOpWavesPipeline({ ...spec, notify }, { specFile: "waves.json", variables: { CHANT_SLACK_WEBHOOK: "${{ vars.SLACK }}" } }).files[0]!.yaml;
    expect(yaml).toContain("env:\n  CHANT_WEBHOOK: '${{ secrets.CHANT_WEBHOOK }}'");
    expect(yaml).toContain("CHANT_WEBHOOK_KEY: '${{ secrets.CHANT_WEBHOOK_KEY }}'");
    expect(yaml).toContain("CHANT_SLACK_WEBHOOK: '${{ vars.SLACK }}'");
    expect(generateGithubOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml).not.toContain("secrets.");
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

  test("a wave-level plan and apply, and stage hooks, render the same jobs: chant run wave runs them (#3762)", () => {
    const { plan: _plan, ...rest } = spec;
    const waveLevel: OpWavesSpec = {
      ...rest,
      planWave: ["./bin/plan-wave", "{runs}", "{plans}"],
      applyWave: ["./bin/apply-wave", "{runs}"],
      hooks: { before: { apply: [{ command: ["./bin/check", "{runs}"], onFailure: "approve" }] } },
    };
    const plain = generateGithubOpWavesPipeline(spec, { specFile: "waves.json" });
    const rendered = generateGithubOpWavesPipeline(waveLevel, { specFile: "waves.json" });
    expect(rendered.files).toEqual(plain.files);
    expect(rendered.jobs).toEqual(plain.jobs);
    expect(() => generateGithubOpWavesPipeline({ ...waveLevel, hooks: { after: { apply: [{ command: ["./bin/smoke"], onFailure: "approve" }] } } }, { specFile: "waves.json" })).toThrow(/nothing left to hold/);
  });
});

describe("a runner per wave and job groups per wave (#3914)", () => {
  const grouped: OpWavesSpec = {
    ...spec,
    runner: "plan",
    waves: [
      { name: "dev", runs: [{ target: "dev" }], gate: "never", runner: ["self-hosted", "dev"] },
      {
        name: "prod",
        runs: [{ target: "us/a" }, { target: "us/b" }, { target: "eu/a" }],
        variables: { STAGE: "apply" },
        idTokens: { PLAN_TOKEN: "plan.example" },
        jobs: [
          { name: "us", runs: ["us/*"], shares: 2, runner: { group: "prod-apply", labels: ["linux"] }, environment: { name: "prod-us" }, variables: { REGION: "us" }, setup: [{ run: "echo us" }], idTokens: { CLOUD_TOKEN: "us.example" } },
          { name: "eu", runs: ["eu/*"], runner: "eu-apply", environment: { name: "prod-eu" } },
        ],
      },
    ],
  };

  test("the rendered pipeline matches its golden", async () => {
    await expect(generateGithubOpWavesPipeline(grouped, { specFile: "waves.json" }).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-jobs.yml");
  });

  test("runs-on, environment, variables, id-token and the group's command on each job", () => {
    const { files, jobs } = generateGithubOpWavesPipeline(grouped, { specFile: "waves.json" });
    expect(jobs.map((j) => j.jobName)).toEqual(["wave-1-dev", "wave-2-prod-decide", "wave-2-prod-us-share-1", "wave-2-prod-us-share-2", "wave-2-prod-eu"]);
    const yaml = files[0]!.yaml;
    expect(yaml).toMatch(/wave-1-dev:\n\s+runs-on:\n\s+- self-hosted\n\s+- dev\n/);
    expect(yaml).toMatch(
      /wave-2-prod-decide:\n\s+runs-on: plan\n[\s\S]*?permissions:\n\s+contents: write\n\s+id-token: write\n\s+env:\n\s+STAGE: apply\n\s+PLAN_TOKEN_AUDIENCE: plan.example\n/,
    );
    expect(yaml).toMatch(
      /wave-2-prod-us-share-1:\n\s+runs-on:\n\s+group: prod-apply\n\s+labels:\n\s+- linux\n\s+needs:\n\s+- wave-2-prod-decide\n\s+container: node:22\n\s+environment:\n\s+name: prod-us\n\s+permissions:\n\s+contents: write\n\s+id-token: write\n\s+env:\n\s+STAGE: apply\n\s+REGION: us\n\s+CLOUD_TOKEN_AUDIENCE: us.example\n/,
    );
    expect(yaml).toContain("- run: echo us\n      - name: Apply share 1 of job group us of wave 2 (prod)\n        run: chant run wave --spec waves.json --wave 2 --group us --share 1\n");
    // A group with no id tokens of its own gets the wave's.
    expect(yaml).toMatch(/wave-2-prod-eu:\n\s+runs-on: eu-apply\n[\s\S]*?name: prod-eu\n\s+permissions:\n\s+contents: write\n\s+id-token: write\n\s+env:\n\s+STAGE: apply\n\s+PLAN_TOKEN_AUDIENCE: plan.example\n/);
    expect(yaml).toContain("run: chant run wave --spec waves.json --wave 2 --group eu\n");
  });

  test("the spec's runner is the resume and record-plans jobs' too", () => {
    const { files } = generateGithubOpWavesPipeline({ ...spec, runner: "plan", resume: { schedule: "*/10 * * * *" }, waves: spec.waves.map((w) => ({ ...w, approval: "pr-review" as const })) }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual(["migrations.yml", "migrations-resume.yml", "migrations-plans.yml"]);
    for (const f of files) expect(f.yaml).not.toContain("ubuntu-latest");
  });

  test("words.bin is the command in every job line: the waves, resume and the plans job (#4607)", () => {
    const bin = "npx --no-install plywood";
    const withBin = { ...spec, resume: { schedule: "*/10 * * * *" }, waves: spec.waves.map((w, i) => (i === spec.waves.length - 1 ? { ...w, approval: "pr-review" as const } : w)) };
    const { files, jobs } = generateGithubOpWavesPipeline(withBin, { specFile: "waves.json", bin });
    expect(jobs.every((j) => j.command.slice(0, 3).join(" ") === bin)).toBe(true);
    const yaml = files.map((f) => f.yaml).join("\n");
    expect(yaml).toContain("run: npx --no-install plywood run wave --spec waves.json --wave 1");
    expect(yaml).toContain("npx --no-install plywood run resume --op migrations");
    expect(yaml).toContain("npx --no-install plywood run wave --spec waves.json --record-plans");
    expect(yaml).not.toMatch(/(^|\s)chant run (wave|resume)/m);
  });

  test("no bin keeps chant (#4607)", () => {
    const { jobs } = generateGithubOpWavesPipeline(spec, { specFile: "waves.json" });
    expect(jobs.every((j) => j.command[0] === "chant")).toBe(true);
  });
});
