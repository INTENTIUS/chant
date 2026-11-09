import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["./bin/plan", "{target}", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "a" }, { target: "b" }], gate: "on-destructive", shares: 2, approval: "pr-review" },
  ],
};
const options = { specFile: "waves.json", beforeScript: ["npm ci"] };

/** What sql-yodeler used to edit into chant's output, passed as inputs instead. */
const inputs: OpWavesPipelineOptions = {
  ...options,
  bin: "npx --no-install yodel chant",
  waveJobs: {
    dev: {
      before: [{ name: "Log in to the cloud", run: ["export TRADE=dev", "trade dev"] }],
      report: { name: "Report dev", run: ["yodel report dev"] },
      artifact: { step: "Keep the report", name: "yodel-report-{job}", path: "yodel-report/" },
    },
    prod: { report: { name: "Report prod", run: ["yodel report prod"] }, artifact: { step: "Keep the report", name: "yodel-report-{job}", path: "yodel-report/" } },
  },
  recordPlans: {
    before: [{ name: "This job cannot write", run: ["yodel config check dev prod --write-probe"] }],
    variables: { YODEL_WAVE_RECORD_PLANS: "1" },
    idTokens: { AWS_ID_TOKEN: "sts.amazonaws.com" },
  },
};

describe("generateGithubOpWavesPipeline: a product's inputs (#4791)", () => {
  test("without them, every file renders as it did before they existed", async () => {
    const { files } = generateGithubOpWavesPipeline(spec, options);
    for (const file of files) await expect(file.yaml).toMatchFileSnapshot(`./__golden__/op-waves-inputs-none-${file.name.replace(/\.gitlab-ci\.yml$|\.yml$/, "")}.yml`);
    // Empty inputs are no inputs.
    expect(generateGithubOpWavesPipeline(spec, { ...options, waveJobs: {}, recordPlans: {} }).files).toEqual(files);
  });

  test("a waveJobs key that names no wave is refused", () => {
    expect(() => generateGithubOpWavesPipeline(spec, { ...options, waveJobs: { staging: {} } })).toThrow(/waveJobs names the wave "staging", which the spec does not have \(dev, prod\)/);
  });

  test("every command line runs the product's bin, so nothing is left to rewrite", () => {
    for (const file of generateGithubOpWavesPipeline(spec, inputs).files) {
      expect(file.yaml).not.toMatch(/^\s*(- |run: )?chant /m);
      expect(file.yaml).toContain("npx --no-install yodel chant run ");
    }
  });

  type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> };
  type Job = { steps: Step[]; env?: Record<string, string>; permissions?: Record<string, string>; "enable-openid-connect"?: boolean };
  const jobsOf = (yaml: string) => (parseYAML(yaml) as { jobs: Record<string, Job> }).jobs;
  const named = (job: Job) => job.steps.map((st) => st.name ?? st.uses);

  test("a wave's login runs just before its command, and its report and upload last, whatever the exit", () => {
    const jobs = jobsOf(generateGithubOpWavesPipeline(spec, inputs).files[0]!.yaml);
    const dev = jobs["wave-1-dev"]!;
    const at = named(dev).indexOf("Log in to the cloud");
    expect(dev.steps[at]!.run).toBe("export TRADE=dev\ntrade dev\n");
    expect(dev.steps[at - 1]!.run).toBe("npm ci");
    expect(dev.steps[at + 1]!.run).toBe("npx --no-install yodel chant run wave --spec waves.json --wave 1");
    expect(dev.steps.slice(-2)).toEqual([
      { name: "Report dev", if: "always()", run: "yodel report dev" },
      expect.objectContaining({ name: "Keep the report", if: "always()", with: expect.objectContaining({ name: "yodel-report-wave-1-dev", path: "yodel-report/" }) }),
    ]);
    // Every job of a wide wave reports, each under its own artifact; only dev logs in.
    for (const name of ["wave-2-prod-decide", "wave-2-prod-share-1", "wave-2-prod-share-2"]) {
      const job = jobs[name]!;
      expect(named(job)).not.toContain("Log in to the cloud");
      expect(job.steps.at(-2)).toEqual({ name: "Report prod", if: "always()", run: "yodel report prod" });
      expect(job.steps.at(-1)!.with!.name).toBe(`yodel-report-${name}`);
    }
  });

  test("the plans job gets its steps before it plans, its variables, and its OIDC tokens", () => {
    const plans = generateGithubOpWavesPipeline(spec, inputs).files.find((f) => f.name === "migrations-plans.yml")!;
    const job = jobsOf(plans.yaml)["record-plans"]!;
    const at = named(job).indexOf("This job cannot write");
    expect(job.steps[at]!.run).toBe("yodel config check dev prod --write-probe");
    expect(job.steps[at + 1]!.run).toBe("npx --no-install yodel chant run wave --spec waves.json --record-plans");
    expect(job.env).toEqual({ YODEL_WAVE_RECORD_PLANS: "1", AWS_ID_TOKEN_AUDIENCE: "sts.amazonaws.com" });
    expect(job.permissions).toEqual({ contents: "write", "id-token": "write" });
  });

});
