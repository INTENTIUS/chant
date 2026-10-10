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
});
