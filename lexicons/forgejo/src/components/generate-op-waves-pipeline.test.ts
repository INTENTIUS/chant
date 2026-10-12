import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "staging", runs: [{ target: "staging" }] },
    { name: "prod", runs: [{ target: "prod" }], environment: { name: "production" } },
  ],
};

describe("generateForgejoOpWavesPipeline", () => {
  test("the waves under the Forgejo dialect: chained by needs, no permissions, the environment named as dropped", () => {
    const { files, jobs } = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" });
    expect(jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["wave-1-dev", []],
      ["wave-2-staging", ["wave-1-dev"]],
      ["wave-3-prod", ["wave-2-staging"]],
    ]);
    const yaml = files[0]!.yaml;
    expect(files[0]!.name).toBe("migrations.yml");
    expect(yaml).toContain("# chant dropped the environment of each of these waves: prod -> production.");
    expect(yaml).not.toMatch(/^\s+environment:/m);
    expect(yaml).not.toMatch(/^permissions:/m);
    expect(yaml).toMatch(/wave-3-prod:\n\s+runs-on: docker\n\s+needs:\n\s+- wave-2-staging/);
    expect(yaml).toContain("run: chant run wave --spec waves.json --wave 3\n");
    expect(yaml).toContain("fetch-depth: 0");
  });

  test("resume renders a scheduled workflow that dispatches with the CHANT_FORGE_TOKEN secret (#3683)", () => {
    const { files } = generateForgejoOpWavesPipeline({ ...spec, resume: { schedule: "*/10 * * * *" } }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual(["migrations.yml", "migrations-resume.yml"]);
    const yaml = files[1]!.yaml;
    expect(yaml).toContain("run: chant run resume --op migrations");
    expect(yaml).toContain("CHANT_FORGE_TOKEN: '${{ secrets.CHANT_FORGE_TOKEN }}'");
    expect(yaml).not.toContain("github.token");
    expect(yaml).not.toMatch(/^permissions:/m);
  });

  test("a pr-review wave adds a pull request workflow that records the head's plans (#3684)", () => {
    const { files } = generateForgejoOpWavesPipeline({ ...spec, waves: spec.waves.map((w, i) => (i === spec.waves.length - 1 ? { ...w, approval: "pr-review" as const } : w)) }, { specFile: "waves.json" });
    expect(files.map((f) => f.name)).toEqual([`${spec.name}.yml`, `${spec.name}-plans.yml`]);
    expect(files[1]!.yaml).toContain("pull_request:");
    expect(files[1]!.yaml).toContain("run: chant run wave --spec waves.json --record-plans");
  });

  test("a wave-level plan and apply, and stage hooks, render the same jobs: chant run wave runs them (#3762)", () => {
    const { plan: _plan, ...rest } = spec;
    const waveLevel: OpWavesSpec = {
      ...rest,
      planWave: ["./bin/plan-wave", "{runs}", "{plans}"],
      applyWave: ["./bin/apply-wave", "{runs}"],
      hooks: { before: { apply: [{ command: ["./bin/check", "{runs}"], onFailure: "approve" }] } },
    };
    const plain = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" });
    const rendered = generateForgejoOpWavesPipeline(waveLevel, { specFile: "waves.json" });
    expect(rendered.files).toEqual(plain.files);
    expect(rendered.jobs).toEqual(plain.jobs);
    expect(() => generateForgejoOpWavesPipeline({ ...waveLevel, hooks: { after: { apply: [{ command: ["./bin/smoke"], onFailure: "approve" }] } } }, { specFile: "waves.json" })).toThrow(/nothing left to hold/);
  });
});

describe("a runner per wave and job groups per wave (#3914)", () => {
  const grouped: OpWavesSpec = {
    ...spec,
    runner: "plan",
    waves: [
      { name: "dev", runs: [{ target: "dev" }], gate: "never" },
      {
        name: "prod",
        runs: [{ target: "us/a" }, { target: "eu/a" }],
        jobs: [
          { name: "us", runs: ["us/*"], runner: ["self-hosted", "us"], variables: { REGION: "us" }, idTokens: { CLOUD_TOKEN: "us.example" } },
          { name: "eu", runs: ["eu/*"], runner: "eu-apply" },
        ],
      },
    ],
  };

  test("the rendered pipeline matches its golden", async () => {
    await expect(generateForgejoOpWavesPipeline(grouped, { specFile: "waves.json" }).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-jobs.yml");
  });

  test("groups render as their own jobs with their runner, variables and id-token: write", () => {
    const { files, jobs } = generateForgejoOpWavesPipeline(grouped, { specFile: "waves.json" });
    expect(jobs.map((j) => j.jobName)).toEqual(["wave-1-dev", "wave-2-prod-decide", "wave-2-prod-us", "wave-2-prod-eu"]);
    const yaml = files[0]!.yaml;
    expect(yaml).toMatch(/wave-1-dev:\n\s+runs-on: plan\n/);
    expect(yaml).toMatch(/wave-2-prod-us:\n\s+runs-on:\n\s+- self-hosted\n\s+- us\n[\s\S]*?permissions:\n\s+id-token: write\n\s+env:\n\s+REGION: us\n\s+CLOUD_TOKEN_AUDIENCE: us.example\n/);
    expect(yaml).toMatch(/wave-2-prod-eu:\n\s+runs-on: eu-apply\n\s+needs:\n\s+- wave-2-prod-decide\n\s+container: node:22\n\s+steps:/);
    expect(yaml).not.toContain("contents: write");
  });

  test("a runner group, or an environment on a job group, is a spec error naming the wave and the field", () => {
    const prod = grouped.waves[1]!;
    const withGroup = (g: Record<string, unknown>): OpWavesSpec => ({ ...grouped, waves: [grouped.waves[0]!, { ...prod, jobs: [{ ...prod.jobs![0]!, ...g }, prod.jobs![1]!] }] });
    expect(() => generateForgejoOpWavesPipeline(withGroup({ environment: { name: "prod-us" } }), { specFile: "waves.json" })).toThrow(/wave "prod" job group "us" names the environment "prod-us", but Forgejo Actions has no environments/);
    expect(() => generateForgejoOpWavesPipeline(withGroup({ runner: { group: "apply" } }), { specFile: "waves.json" })).toThrow(/wave "prod" job group "us" runner is the runner group "apply", which only GitHub has/);
    expect(() => generateForgejoOpWavesPipeline({ ...grouped, waves: [{ ...grouped.waves[0]!, runner: { group: "x" } }] }, { specFile: "waves.json" })).toThrow(/wave "dev" runner is the runner group/);
  });
});
