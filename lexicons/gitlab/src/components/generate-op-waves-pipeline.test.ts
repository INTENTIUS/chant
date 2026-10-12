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

  test("a wave-level plan and apply, and stage hooks, render the same jobs: chant run wave runs them (#3762)", () => {
    const { plan: _plan, ...rest } = spec;
    const waveLevel: OpWavesSpec = {
      ...rest,
      planWave: ["./bin/plan-wave", "{runs}", "{plans}"],
      applyWave: ["./bin/apply-wave", "{runs}"],
      hooks: { before: { apply: [{ command: ["./bin/check", "{runs}"], onFailure: "approve" }] } },
    };
    const plain = generateGitlabOpWavesPipeline(spec, { specFile: "waves.json" });
    const rendered = generateGitlabOpWavesPipeline(waveLevel, { specFile: "waves.json" });
    expect(rendered.files).toEqual(plain.files);
    expect(rendered.jobs).toEqual(plain.jobs);
    expect(() => generateGitlabOpWavesPipeline({ ...waveLevel, hooks: { after: { apply: [{ command: ["./bin/smoke"], onFailure: "approve" }] } } }, { specFile: "waves.json" })).toThrow(/nothing left to hold/);
  });
});

describe("a wave's environment is checked as an Op's is (#3765)", () => {
  test("a blank name or a relative url is refused, and a $VARIABLE url passes", () => {
    const one = (environment: { name: string; url?: string }): OpWavesSpec => ({ ...spec, waves: [{ name: "dev", runs: [{ target: "dev" }], environment }] });
    expect(() => generateGitlabOpWavesPipeline(one({ name: " " }), { specFile: "waves.json" })).toThrow(/environment has an empty `name`/);
    expect(() => generateGitlabOpWavesPipeline(one({ name: "dev", url: "dev/app" }), { specFile: "waves.json" })).toThrow(/neither an absolute/);
    expect(generateGitlabOpWavesPipeline(one({ name: "dev", url: "$CI_ENVIRONMENT_URL" }), { specFile: "waves.json" }).files[0]!.yaml).toContain("url: '$CI_ENVIRONMENT_URL'");
  });
});

describe("a runner per wave and job groups per wave (#3914)", () => {
  const grouped: OpWavesSpec = {
    ...spec,
    runner: "plan",
    waves: [
      { name: "dev", runs: [{ target: "dev" }], gate: "never", runner: ["docker", "dev"] },
      {
        name: "prod",
        runs: [{ target: "us/a" }, { target: "eu/a" }],
        idTokens: { PLAN_TOKEN: "plan.example" },
        jobs: [
          { name: "us", runs: ["us/*"], runner: "us-apply", environment: { name: "prod-us" }, variables: { REGION: "us" }, setup: [{ run: "echo us" }], idTokens: { CLOUD_TOKEN: "us.example" } },
          { name: "eu", runs: ["eu/*"], runner: "eu-apply", environment: { name: "prod-eu" }, idTokens: { CLOUD_TOKEN: "eu.example" } },
        ],
      },
    ],
  };

  test("the rendered pipeline matches its golden", async () => {
    await expect(generateGitlabOpWavesPipeline(grouped, { specFile: "waves.json" }).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-jobs.yml");
  });

  test("tags, environment, id_tokens, variables and the group's command on each job", () => {
    const yaml = generateGitlabOpWavesPipeline(grouped, { specFile: "waves.json" }).files[0]!.yaml;
    expect(yaml).toMatch(/wave-1-dev:\n\s+stage: wave-1-dev\n\s+image: node:22\n\s+tags:\n\s+- docker\n\s+- dev\n/);
    expect(yaml).toMatch(/wave-2-prod-decide:\n\s+stage: wave-2-prod\n\s+image: node:22\n\s+tags:\n\s+- plan\n\s+resource_group: migrations-prod\n\s+id_tokens:\n\s+PLAN_TOKEN:\n\s+aud: plan.example\n/);
    expect(yaml).toMatch(
      /wave-2-prod-us:\n\s+stage: wave-2-prod\n\s+image: node:22\n\s+tags:\n\s+- us-apply\n\s+resource_group: migrations-prod\n\s+environment:\n\s+name: prod-us\n\s+id_tokens:\n\s+CLOUD_TOKEN:\n\s+aud: us.example\n\s+variables:\n\s+GIT_DEPTH: '0'\n\s+REGION: us\n[\s\S]*?needs:\n\s+- wave-2-prod-decide\n\s+script:\n\s+- echo us\n\s+- chant run wave --spec waves.json --wave 2 --group us\n/,
    );
    expect(yaml).toMatch(/wave-2-prod-eu:[\s\S]*?id_tokens:\n\s+CLOUD_TOKEN:\n\s+aud: eu.example\n/);
    expect(yaml).not.toContain("_AUDIENCE");
  });

  test("a runner group is a spec error naming the wave and the field", () => {
    const withGroup = (runner: { group: string }) => ({ ...grouped, waves: [grouped.waves[0]!, { ...grouped.waves[1]!, jobs: [{ ...grouped.waves[1]!.jobs![0]!, runner }, grouped.waves[1]!.jobs![1]!] }] });
    expect(() => generateGitlabOpWavesPipeline(withGroup({ group: "apply" }), { specFile: "waves.json" })).toThrow(/wave "prod" job group "us" runner is the runner group "apply", which only GitHub has/);
    expect(() => generateGitlabOpWavesPipeline({ ...spec, runner: { group: "apply" } }, { specFile: "waves.json" })).toThrow(/Op waves "migrations": runner is the runner group/);
  });
});
