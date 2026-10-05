/**
 * The generated merge-request pipeline for GitLab CI (#3183): a plan job in
 * each merge request pipeline, an apply job on each push to the default
 * branch. The whole file has a golden, and it validates against the GitLab
 * CI schema this lexicon vendors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";
import { PR_LOOP_SETUP } from "@intentius/chant/components/pr-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop.gitlab.golden.yml");
const SCHEMA = join(import.meta.dirname, "..", "codegen", "vendored", "gitlab-ci-schema.json");

interface Job {
  rules: Array<{ if: string }>;
  variables: Record<string, string>;
  script: string[];
  resource_group?: string;
  image?: string;
  artifacts: Record<string, unknown>;
}

describe("the GitLab merge-request pipeline", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {} });
  const doc = parseYAML(result.yaml) as { workflow: { rules: unknown[] }; variables: Record<string, string>; plan: Job; apply: Job };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("validates against the vendored GitLab CI schema", () => {
    const req = createRequire(import.meta.url);
    const mod = req("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("plans in a merge request pipeline from its diff base, applies on a push to the default branch, one at a time", () => {
    expect(doc.plan.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(doc.plan.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" });
    expect(doc.plan.script).toEqual([
      ...PR_LOOP_SETUP,'chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --output .chant/pr --forge gitlab']);
    expect(doc.apply.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc.apply.variables).toEqual({ BASE_SHA: "$CI_COMMIT_BEFORE_SHA" });
    expect(doc.apply.script.at(-1)).toContain("--require-review");
    expect(doc.apply.resource_group).toBe("chant-apply-prod");
    expect(doc.variables.GIT_DEPTH).toBe("0");
    expect(doc.apply.artifacts).toEqual({ when: "always", paths: [".chant/pr"] });
  });

  test("runs in an image with git and installs OpenTofu, unless the caller names an image", () => {
    expect(doc.plan.image).toBe("node:22");
    expect(doc.apply.script[0]).toBe(PR_LOOP_SETUP[0]);
    const own = generateGitlabPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: {} }).yaml;
    expect(own).toContain("image: example/ci:1");
    expect(own).not.toContain("install-opentofu");
  });

  test("an all-zero CI_COMMIT_BEFORE_SHA falls back to the merge request diff base, then the target branch", () => {
    const line = doc.apply.script.find((l) => l.includes("CI_MERGE_REQUEST_DIFF_BASE_SHA"))!;
    expect(line).toContain("0000000000000000000000000000000000000000");
    expect(line).toContain("git fetch origin $CI_DEFAULT_BRANCH");
    expect(doc.apply.script.indexOf(line)).toBeLessThan(doc.apply.script.length - 1);
    expect(doc.plan.script.some((l) => l.includes("CI_MERGE_REQUEST_DIFF_BASE_SHA"))).toBe(false);
  });

  test("a named branch replaces the default branch in the apply rule", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { branch: "trunk" } }).yaml;
    expect(yaml).toContain('$CI_COMMIT_BRANCH == "trunk"');
  });

  test("refuses a wave or promote job beside it", () => {
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: {}, gatedWaves: { gate: "g" } })).toThrow(/pull-request pipeline has no wave or promote jobs/);
  });

  test("inside a workspace member: member-named jobs that cd into the member, with no changes rule (#3465)", () => {
    const member = { name: "network", dir: "infra/network", file: ".gitlab/ci/chant-pr-network-prod.gitlab-ci.yml" };
    const scoped = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {}, member });
    const mdoc = parseYAML(scoped.yaml) as Record<string, unknown> & { workflow: { name: string } };
    expect(scoped.jobs.map((j) => j.jobName)).toEqual(["network-plan", "network-apply"]);
    expect(mdoc.plan).toBeUndefined();
    expect(mdoc.workflow.name).toBe("chant-pr-network-prod");
    const plan = mdoc["network-plan"] as Job;
    const apply = mdoc["network-apply"] as Job;
    expect(plan.script).toContain("cd infra/network");
    expect(plan.script.indexOf("cd infra/network")).toBeLessThan(plan.script.findIndex((l) => l.includes("pr-plan")));
    expect(plan.script.find((l) => l.includes("pr-plan"))).toContain("--member network");
    expect(apply.script.find((l) => l.includes("pr-apply"))).toContain("--member network");
    // A change outside the member can reach it, so the jobs keep only their pipeline-source rules.
    expect(plan.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(apply.resource_group).toBe("chant-apply-network-prod");
    expect(plan.artifacts).toEqual({ when: "always", paths: ["infra/network/.chant/pr"] });
    expect(apply.artifacts).toEqual({ when: "always", paths: ["infra/network/.chant/pr"] });
  });
});
