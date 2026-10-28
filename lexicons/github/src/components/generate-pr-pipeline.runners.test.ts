/**
 * The pull request loop's runners, variables and passed secrets on GitHub
 * (#4625): every job on its stage's runner, and the jobs that plan or apply
 * with the variables and the secrets mapped from the repository's. Written
 * for the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const, lock: "lock" as const, unlock: "unlock" as const } };

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Doc = { jobs: Record<string, { "runs-on": unknown; steps: Step[] }> };

const doc = parseYAML(
  generateGithubPipeline(ESTATE, {
    env: "prod",
    prLoop: {
      words: WORDS,
      previewComment: true,
      locks: "plan",
      applyOnMerge: true,
      runners: { plan: ["self-hosted", "big"], apply: "deployer", default: "small" },
      variables: { REGION: "eu-west-1" },
      secrets: { DB_PASSWORD: "PROD_DB_PASSWORD" },
      parallelism: 2,
    },
  }).yaml,
) as Doc;

describe("the GitHub pull request loop's runners and variables (#4625)", () => {
  test("every job runs on its stage's runner", () => {
    expect(doc.jobs.plan!["runs-on"]).toEqual(["self-hosted", "big"]);
    expect(doc.jobs["comment-preview"]!["runs-on"]).toEqual(["self-hosted", "big"]);
    expect(doc.jobs.apply!["runs-on"]).toBe("deployer");
    expect(doc.jobs.record!["runs-on"]).toBe("deployer");
    for (const name of ["plan-note", "comment-preview-note", "lock", "unlock", "comment-lock", "comment-unlock"]) expect(doc.jobs[name]!["runs-on"], name).toBe("small");
  });

  test("the plan step gets the variable and the secret, and still drops the forge tokens first", () => {
    const step = doc.jobs.plan!.steps.find((s) => s.name === "Plan the members this pull request reaches")!;
    expect(step.env).toMatchObject({ REGION: "eu-west-1", DB_PASSWORD: "${{ secrets.PROD_DB_PASSWORD }}" });
    expect(step.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(step.run!.split("\n")[0]).toContain("unset");
    expect(step.run).toContain("--parallelism 2");
  });

  test("the apply step gets them too", () => {
    const step = doc.jobs.apply!.steps.find((s) => s.run?.includes("ci run apply"))!;
    expect(step.env).toMatchObject({ REGION: "eu-west-1", DB_PASSWORD: "${{ secrets.PROD_DB_PASSWORD }}" });
  });

  test("without runners every job keeps the forge's default", () => {
    const plain = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml) as Doc;
    expect(plain.jobs.plan!["runs-on"]).toBe("ubuntu-latest");
  });
});
