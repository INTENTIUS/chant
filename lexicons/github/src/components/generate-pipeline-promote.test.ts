import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { generateGithubPipelinePromote } from "./generate-pipeline-promote";
import { githubPlugin } from "../plugin";

const input: PipelinePromoteInput = {
  pipeline: "shop",
  stages: [
    { name: "staging", environment: { name: "staging" } },
    { name: "prod", environment: { name: "prod", url: "https://shop.example" } },
  ],
  bin: "npx --no-install plywood",
};

const yaml = (i: PipelinePromoteInput) => generateGithubPipelinePromote(i)[0]!.yaml;

describe("github pipeline promote", () => {
  test("golden", async () => {
    await expect(yaml(input)).toMatchFileSnapshot("./__golden__/pipeline-promote.github.yml");
  });

  test("file name and one job per stage", () => {
    const files = generateGithubPipelinePromote(input);
    expect(files.map((f) => f.name)).toEqual(["shop-promote.yml"]);
    expect(files[0]!.yaml).toContain("promote-staging:");
    expect(files[0]!.yaml).toContain("promote-prod:");
  });

  test("bin and default bin", () => {
    expect(yaml(input)).toContain('npx --no-install plywood components promote --to prod --release "$CHANT_PROMOTE_RELEASE"');
    expect(yaml({ ...input, bin: undefined })).toContain('chant components promote --to staging --release "$CHANT_PROMOTE_RELEASE"');
  });

  test("runner", () => {
    expect(yaml({ ...input, runner: "big-box" })).toContain("big-box");
  });

  test("environment", () => {
    const out = yaml(input);
    expect(out).toContain("environment:");
    expect(out).toContain("https://shop.example");
  });

  test("refuses no stages and a bad name", () => {
    expect(() => yaml({ ...input, stages: [] })).toThrow(/no stages/);
    expect(() => yaml({ ...input, stages: [{ name: "Prod" }] })).toThrow(/not a valid name/);
  });

  test("recheck (#5326): a schedule and a recheck job per stage, golden", async () => {
    const out = yaml({ ...input, recheck: { schedule: "0 * * * *" } });
    await expect(out).toMatchFileSnapshot("./__golden__/pipeline-promote-recheck.github.yml");
    expect(out).toContain("cron: '0 * * * *'");
    expect(out).toContain("recheck-staging:");
    expect(out).toContain("npx --no-install plywood components promote --to prod --pending");
    expect(yaml(input)).not.toContain("schedule");
    expect(yaml(input)).not.toContain("recheck-");
  });

  test("the plugin exposes it", () => {
    expect(githubPlugin.generatePipelinePromote!(input)).toHaveLength(1);
  });
});

// #5339: with agentFacts, the promote and recheck steps record failed verifies and soaks for the verify-failed agent.
describe("github pipeline promote: the verify-failed facts", () => {
  test("the command step holds CHANT_AGENT_FACTS=verify-failed and the relay key; without agentFacts, nothing", () => {
    const doc = parseYAML(yaml({ ...input, recheck: { schedule: "0 * * * *" }, agentFacts: { relayKeyEnv: "OPS_RELAY" } })) as unknown as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
    for (const name of ["promote-staging", "promote-prod", "recheck-staging", "recheck-prod"]) {
      const step = doc.jobs[name]!.steps.find((s) => s.run?.includes("components promote"))!;
      expect(step.env, name).toMatchObject({ CHANT_AGENT_FACTS: "verify-failed", CHANT_RELAY_KEY: "${{ secrets.OPS_RELAY }}" });
    }
    expect(yaml(input)).not.toContain("CHANT_AGENT_FACTS");
  });
});

// #5427: a stage whose command requests the forge's OIDC token itself, with no cloud trade.
describe("github pipeline promote: idTokens", () => {
  type Doc = { jobs: Record<string, { permissions?: Record<string, string>; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }> };
  const doc = (i: PipelinePromoteInput) => parseYAML(yaml(i)) as unknown as Doc;
  const tokens = { ...input, stages: [{ name: "staging", idTokens: { AWS_ID_TOKEN: "sts.amazonaws.com" } }, { name: "prod" }] };

  test("the job gets id-token: write, the step the audience, and the request variables stay", () => {
    const jobs = doc(tokens).jobs;
    expect(jobs["promote-staging"]!.permissions).toEqual({ contents: "write", "id-token": "write" });
    const step = jobs["promote-staging"]!.steps.find((s) => s.run?.includes("components promote"))!;
    expect(step.env).toMatchObject({ AWS_ID_TOKEN_AUDIENCE: "sts.amazonaws.com" });
    expect(step.run).not.toContain("unset");
    expect(jobs["promote-staging"]!.steps.some((s) => s.name?.startsWith("Trade"))).toBe(false);
    expect(jobs["promote-prod"]!.permissions).toBeUndefined();
  });

  test("beside a trade, the request variables stay for the command", () => {
    const both = doc({ ...input, stages: [{ name: "staging", cloud: { aws: { role: "arn:aws:iam::1:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } }, idTokens: { DB_TOKEN: "rds" } }] });
    const job = both.jobs["promote-staging"]!;
    expect(job.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(job.steps.find((s) => s.run?.includes("components promote"))!.run).not.toContain("unset");
  });

  test("idTokens that are not { variable: audience } are refused", () => {
    expect(() => yaml({ ...input, stages: [{ name: "staging", idTokens: { "1BAD": "aud" } }] })).toThrow(/not a variable name/);
    expect(() => yaml({ ...input, stages: [{ name: "staging", idTokens: {} }] })).toThrow(/at least one token/);
  });

  test("without idTokens the file is as before", async () => {
    await expect(yaml(input)).toMatchFileSnapshot("./__golden__/pipeline-promote.github.yml");
  });
});

// #5425: the product's image and install lines, as the wave jobs take them.
describe("github pipeline promote: the product's image and install lines", () => {
  const withProduct = { ...input, recheck: { schedule: "0 * * * *" }, image: "ghcr.io/intentius/plunge:1", beforeScript: ["npm ci --ignore-scripts"] };
  type Doc = { jobs: Record<string, { container: string; steps: Array<{ run?: string }> }> };

  test("every job runs in the image and installs before its command", () => {
    const doc = parseYAML(yaml(withProduct)) as unknown as Doc;
    for (const name of ["promote-staging", "promote-prod", "recheck-staging", "recheck-prod"]) {
      expect(doc.jobs[name]!.container, name).toBe("ghcr.io/intentius/plunge:1");
      const run = doc.jobs[name]!.steps.find((s) => s.run?.includes("components promote"))!.run!;
      expect(run.indexOf("npm ci --ignore-scripts"), name).toBeGreaterThanOrEqual(0);
      expect(run.indexOf("npm ci --ignore-scripts"), name).toBeLessThan(run.indexOf("components promote"));
    }
  });

  test("the agent job takes them too", () => {
    const agentInput = { ...withProduct, stages: [{ name: "staging", agentSteps: { keyEnvs: ["MODEL_KEY"] } }] };
    const doc = parseYAML(yaml(agentInput)) as unknown as Doc;
    expect(doc.jobs["agent-staging"]!.container).toBe("ghcr.io/intentius/plunge:1");
    expect(doc.jobs["agent-staging"]!.steps.some((s) => s.run === "npm ci --ignore-scripts")).toBe(true);
  });

  test("with neither set, the file is the golden's", async () => {
    await expect(yaml({ ...input, image: undefined, beforeScript: undefined })).toMatchFileSnapshot("./__golden__/pipeline-promote.github.yml");
  });
});
