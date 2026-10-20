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
import { PR_LOOP_SETUP, prLoopJobs } from "@intentius/chant/components/pr-pipeline";

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
  cache?: Record<string, unknown>;
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
      ...PR_LOOP_SETUP,'chant ci run plan --in-place --no-push --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --forge gitlab']);
    expect(doc.apply.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc.apply.variables).toEqual({ BASE_SHA: "$CI_COMMIT_BEFORE_SHA" });
    // #4156: ci run builds pr-apply with --require-review, and GitLab hands CHANT_RUNNER_KEY to the job as a CI/CD variable when it has one.
    expect(doc.apply.script.at(-1)).toBe('chant ci run apply --in-place --base "$BASE_SHA" --env prod --gate pr-apply --forge gitlab');
    expect(result.yaml).not.toContain("CHANT_RUNNER_KEY");
    expect(doc.apply.resource_group).toBe("chant-apply-prod");
    expect(doc.variables.GIT_DEPTH).toBe("0");
    expect(doc.apply.artifacts).toEqual({ when: "always", paths: [".chant/pr"] });
  });

  test("events and reportUrl stream the run's events into the report artifact and copy the reports out (#4007)", () => {
    const loud = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { events: true, reportUrl: "$CHANT_REPORT_URL" } }).yaml) as { plan: Job; apply: Job };
    for (const job of [loud.plan, loud.apply]) {
      expect(job.script.at(-1)).toContain('--events-json --report-url "$CHANT_REPORT_URL"');
      expect(job.variables.CHANT_RUN_EVENTS_DIR).toBe(".chant/pr/run-events");
      expect(job.artifacts).toEqual({ when: "always", paths: [".chant/pr"] });
    }
    expect(result.yaml).not.toContain("--events-json");
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

  test("the apply resumes from a record the job cache keeps for the pushed commit, failed or not (#3543)", () => {
    expect(doc.apply.script.at(-1)).toContain("--in-place");
    expect(prLoopJobs("gitlab", "prod")[1]!.command).toContain("--resume .chant/pr-resume/pr-apply.json");
    expect(doc.apply.cache).toEqual({ key: "chant-apply-prod-$CI_COMMIT_SHA", paths: [".chant/pr-resume/pr-apply.json"], when: "always" });
    // The plan runs the merge request's code: no cache, no record.
    expect(doc.plan.cache).toBeUndefined();
    expect(doc.plan.script.at(-1)).not.toContain("--resume");
  });

  test("refuses a promote job beside it, and a canary beside --wave-gate (#4003)", () => {
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: {}, promoteTo: "prod" })).toThrow(/pull-request pipeline has no promote job/);
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: {}, gatedWaves: { gate: "g", canary: ["net"] } })).toThrow(/takes no --canary/);
  });

  test("inside a workspace member: member-named jobs that cd into the member, with no changes rule (#3465)", () => {
    const member = { name: "network", dir: "infra/network", file: ".gitlab/ci/chant-pr.network.prod.gitlab-ci.yml" };
    const scoped = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {}, member });
    const mdoc = parseYAML(scoped.yaml) as Record<string, unknown> & { workflow: { name?: string; rules: unknown[] } };
    expect(scoped.jobs.map((j) => j.jobName)).toEqual(["network-plan", "network-apply"]);
    expect(mdoc.plan).toBeUndefined();
    // Included files merge top-level keys: no name, so members do not collide on it.
    expect(mdoc.workflow.name).toBeUndefined();
    expect(mdoc.workflow.rules).toHaveLength(2);
    const plan = mdoc["network-plan"] as Job;
    const apply = mdoc["network-apply"] as Job;
    expect(plan.script).toContain("cd infra/network");
    // ci run, started in the member's directory, finds the member and passes --member to pr-plan and pr-apply.
    expect(plan.script.indexOf("cd infra/network")).toBeLessThan(plan.script.findIndex((l) => l.includes("ci run plan")));
    expect(apply.script.indexOf("cd infra/network")).toBeLessThan(apply.script.findIndex((l) => l.includes("ci run apply")));
    expect(prLoopJobs("gitlab", "prod", {}, "network")[0]!.command).toContain("--member network");
    // A change outside the member can reach it, so the jobs keep only their pipeline-source rules.
    expect(plan.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(apply.resource_group).toBe("chant-apply.network.prod");
    expect(plan.artifacts).toEqual({ when: "always", paths: ["infra/network/.chant/pr"] });
    expect(apply.artifacts).toEqual({ when: "always", paths: ["infra/network/.chant/pr"] });
    expect(apply.cache).toEqual({ key: "chant-apply.network.prod-$CI_COMMIT_SHA", paths: ["infra/network/.chant/pr-resume/pr-apply.json"], when: "always" });
  });
});

describe("the merge-request pipeline's branch (#3765)", () => {
  test("a branch that would break the rules: expression is refused, as an Op's is", () => {
    expect(() => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { branch: "re$lease" } })).toThrow(/filters on branch "re\$lease"/);
  });
});

describe("the gitlab pull-request pipeline with build (#4088)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { build: true } });
  const doc = parseYAML(result.yaml) as Record<string, any>;
  const golden = join(import.meta.dirname, "__fixtures__", "pr-loop-build.gitlab.golden.yml");

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, result.yaml);
    expect(result.yaml).toBe(readFileSync(golden, "utf-8"));
  });

  test("builds, then lints, before pr-plan and pr-apply", () => {
    const script = (job: string) => (doc[job] as { script: string[] }).script;
    for (const job of ["plan", "apply"]) {
      const lines = script(job);
      const i = lines.findIndex((l) => l.startsWith("chant components pr-"));
      expect(lines.slice(i - 2, i)).toEqual(["chant build --env prod", "chant lint"]);
    }
  });

  test("buildCommand replaces the build line and turns the option on", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { buildCommand: "npm run build" } }).yaml;
    expect(yaml).toContain("npm run build");
    expect(yaml).not.toContain("chant build --env");
    expect(yaml).toContain("chant lint");
  });

  test("the default output carries neither line", () => {
    const plain = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml;
    expect(plain).not.toContain("chant lint");
  });
});
