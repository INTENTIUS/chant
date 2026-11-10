/**
 * #4932: a product's setup steps take a name, so its login step renders
 * named on GitHub, in the Op waves pipeline's wave jobs and in the scheduled
 * Op's job, as sql-yodeler writes them.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

type Step = Record<string, unknown>;
const jobSteps = (yaml: string): Record<string, Step[]> => {
  const doc = parseYAML(yaml) as { jobs: Record<string, { steps: Step[] }> };
  return Object.fromEntries(Object.entries(doc.jobs).map(([k, j]) => [k, j.steps]));
};

const login = { name: "Log in to the cloud", run: "trade dev" };

describe("named setup steps on GitHub (#4932)", () => {
  test("a wave's and a job group's setup steps render with their names, before the wave's command", () => {
    const spec: OpWavesSpec = {
      name: "migrations",
      op: "migrate",
      plan: ["./bin/plan", "{target}", "{plan}"],
      waves: [
        { name: "dev", runs: [{ target: "dev" }], gate: "never", setup: [login, { uses: "aws-actions/configure-aws-credentials@v6", name: "AWS role", with: { "aws-region": "eu-west-1" } }] },
        { name: "prod", runs: [{ target: "a" }], gate: "never", jobs: [{ name: "a", runs: ["a"], setup: [{ name: "Log in to prod", run: "trade prod" }] }] },
      ],
    };
    const steps = jobSteps(generateGithubOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml);
    const dev = steps["wave-1-dev"]!;
    expect(dev).toContainEqual({ name: "Log in to the cloud", run: "trade dev" });
    expect(dev).toContainEqual({ name: "AWS role", uses: "aws-actions/configure-aws-credentials@v6", with: { "aws-region": "eu-west-1" } });
    const prod = Object.entries(steps).filter(([k]) => k.startsWith("wave-2-prod")).flatMap(([, s]) => s);
    expect(prod).toContainEqual({ name: "Log in to prod", run: "trade prod" });
  });

  test("a scheduled Op's setup step renders with its name; one without renders as before", () => {
    const spec: ScheduledOpSpec = { name: "watch-dev", trigger: { kind: "schedule", cron: "0 * * * *" }, setup: [login, { run: "echo unnamed" }] };
    const steps = Object.values(jobSteps(generateGithubOpPipeline([spec]).files[0]!.yaml))[0]!;
    expect(steps).toContainEqual({ name: "Log in to the cloud", run: "trade dev" });
    expect(steps).toContainEqual({ run: "echo unnamed" });
  });

  test("a blank or multi-line name is refused", () => {
    const spec: ScheduledOpSpec = { name: "watch-dev", trigger: { kind: "schedule", cron: "0 * * * *" }, setup: [{ name: " ", run: "x" }] };
    expect(() => generateGithubOpPipeline([spec])).toThrow(/setup step 1 has a blank or multi-line `name`/);
    expect(() => generateGithubOpPipeline([{ ...spec, setup: [{ name: "a\nb", uses: "a/b@v1" }] }])).toThrow(/multi-line/);
  });
});
