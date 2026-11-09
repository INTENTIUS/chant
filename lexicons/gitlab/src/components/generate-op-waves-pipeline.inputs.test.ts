import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

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

describe("generateGitlabOpWavesPipeline: a product's inputs (#4791)", () => {
  test("without them, every file renders as it did before they existed", async () => {
    const { files } = generateGitlabOpWavesPipeline(spec, options);
    for (const file of files) await expect(file.yaml).toMatchFileSnapshot(`./__golden__/op-waves-inputs-none-${file.name.replace(/\.gitlab-ci\.yml$|\.yml$/, "")}.yml`);
    // Empty inputs are no inputs.
    expect(generateGitlabOpWavesPipeline(spec, { ...options, waveJobs: {}, recordPlans: {} }).files).toEqual(files);
  });

  test("a waveJobs key that names no wave is refused", () => {
    expect(() => generateGitlabOpWavesPipeline(spec, { ...options, waveJobs: { staging: {} } })).toThrow(/waveJobs names the wave "staging", which the spec does not have \(dev, prod\)/);
  });

  test("every command line runs the product's bin, so nothing is left to rewrite", () => {
    for (const file of generateGitlabOpWavesPipeline(spec, inputs).files) {
      expect(file.yaml).not.toMatch(/^\s*(- |run: )?chant /m);
      expect(file.yaml).toContain("npx --no-install yodel chant run ");
    }
  });

  type Job = { script: string[]; after_script?: string[]; variables?: Record<string, string>; id_tokens?: Record<string, { aud: string }>; artifacts: { name?: string; paths: string[] } };
  const jobsOf = (yaml: string) => parseYAML(yaml) as Record<string, Job>;

  test("a wave's login runs just before its command, its report is the after_script, and its artifacts keep the report with the outcomes", () => {
    const jobs = jobsOf(generateGitlabOpWavesPipeline(spec, inputs).files[0]!.yaml);
    const dev = jobs["wave-1-dev"]!;
    const at = dev.script.indexOf("export TRADE=dev");
    expect(dev.script.slice(at - 1, at + 3)).toEqual(["npm ci", "export TRADE=dev", "trade dev", "npx --no-install yodel chant run wave --spec waves.json --wave 1"]);
    expect(dev.after_script).toEqual(["yodel report dev"]);
    expect(dev.artifacts).toEqual(expect.objectContaining({ name: "yodel-report-wave-1-dev", paths: [".chant/op-waves/migrations/outcomes/", "yodel-report/"] }));
    for (const name of ["wave-2-prod-decide", "wave-2-prod-share-1", "wave-2-prod-share-2"]) {
      const job = jobs[name]!;
      expect(job.script).not.toContain("trade dev");
      expect(job.after_script).toEqual(["yodel report prod"]);
      expect(job.artifacts.name).toBe(`yodel-report-${name}`);
      expect(job.artifacts.paths.at(-1)).toBe("yodel-report/");
    }
    // The decision a share job reads is still kept.
    expect(jobs["wave-2-prod-decide"]!.artifacts.paths).toHaveLength(3);
  });

  test("the plans job gets its lines before it plans, its variables, and its id_tokens", () => {
    const job = jobsOf(generateGitlabOpWavesPipeline(spec, inputs).files[0]!.yaml)["migrations-record-plans"]!;
    expect(job.script.slice(-2)).toEqual(["yodel config check dev prod --write-probe", "npx --no-install yodel chant run wave --spec waves.json --record-plans"]);
    expect(job.variables).toEqual(expect.objectContaining({ GIT_DEPTH: "0", YODEL_WAVE_RECORD_PLANS: "1" }));
    expect(job.id_tokens).toEqual({ AWS_ID_TOKEN: { aud: "sts.amazonaws.com" } });
  });

});
