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
    expect(yaml).toMatch(/wave-2-prod-us:\n\s+runs-on:\n\s+- self-hosted\n\s+- us\n[\s\S]*?permissions:\n\s+id-token: write\n\s+timeout-minutes: 180\n\s+env:\n\s+CHANT_LOCK_WAIT: '10500'\n\s+REGION: us\n\s+CLOUD_TOKEN_AUDIENCE: us.example\n/);
    expect(yaml).toMatch(/wave-2-prod-eu:\n\s+runs-on: eu-apply\n\s+needs:\n\s+- wave-2-prod-decide\n\s+container: node:22\n\s+timeout-minutes: 180\n\s+env:\n\s+CHANT_LOCK_WAIT: '10500'\n\s+steps:/);
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

describe("an Op wave's jobs by cloud identity (#4332)", () => {
  test("the dialect keeps id-token: write, and each job trades before its checkout", async () => {
    const { parseYAML } = await import("@intentius/chant/yaml");
    const { cloudIdentityWave, TRADE_SPEC_ENV } = await import("@intentius/chant/ci-identity");
    const decl = { aws: { rules: [{ targets: ["a/**"], plan: "a-plan", apply: "a-apply" }, { plan: "own-plan", apply: "own-apply" }] } };
    const roots = ["a/x", "b/y"];
    const grouped: OpWavesSpec = { ...spec, waves: [{ name: "prod", runs: roots.map((target) => ({ target })), ...cloudIdentityWave(decl, "prod", undefined, roots) }] };
    const { jobs } = parseYAML(generateForgejoOpWavesPipeline(grouped, { specFile: "waves.json" }).files[0]!.yaml) as { jobs: Record<string, { permissions?: Record<string, string>; steps: Array<{ uses?: string; env?: Record<string, string> }> }> };
    expect(Object.keys(jobs)).toEqual(["wave-1-prod-decide", "wave-1-prod-a", "wave-1-prod-default"]);
    for (const job of Object.values(jobs)) {
      expect(job.permissions).toEqual({ "id-token": "write" });
      // #4624: the apply-job guard comes first, then the trade, then the checkout.
      expect(job.steps[1]!.env![TRADE_SPEC_ENV]).toBeDefined();
      expect(job.steps[2]!.uses).toContain("checkout");
    }
  });

  test("words.bin is the command in every job line: the waves, resume and the plans job (#4607)", () => {
    const bin = "npx --no-install plywood";
    const withBin = { ...spec, resume: { schedule: "*/10 * * * *" }, waves: spec.waves.map((w, i) => (i === spec.waves.length - 1 ? { ...w, approval: "pr-review" as const } : w)) };
    const { files, jobs } = generateForgejoOpWavesPipeline(withBin, { specFile: "waves.json", bin });
    expect(jobs.every((j) => j.command.slice(0, 3).join(" ") === bin)).toBe(true);
    const yaml = files.map((f) => f.yaml).join("\n");
    expect(yaml).toContain("run: npx --no-install plywood run wave --spec waves.json --wave 1");
    expect(yaml).toContain("npx --no-install plywood run resume --op migrations");
    expect(yaml).toContain("npx --no-install plywood run wave --spec waves.json --record-plans");
    expect(yaml).not.toMatch(/(^|\s)chant run (wave|resume)/m);
  });

  test("no bin keeps chant (#4607)", () => {
    const { jobs } = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" });
    expect(jobs.every((j) => j.command[0] === "chant")).toBe(true);
  });
});

describe("the ledger lock (ruling for ci-products 2026-10-28)", () => {
  test("the waves workflow carries no concurrency group, workflow or job; each wave job carries its timeout and the lock wait", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml;
    expect(yaml).not.toContain("concurrency:");
    expect(yaml.match(/timeout-minutes: 180\n/g)).toHaveLength(3);
    expect(yaml.match(/CHANT_LOCK_WAIT: '10500'\n/g)).toHaveLength(3);
  });
});
