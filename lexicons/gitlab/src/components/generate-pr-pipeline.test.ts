/**
 * The generated merge-request pipeline for GitLab CI (#3183): a plan job in
 * each merge request pipeline, an apply job on each push to the default
 * branch. The whole file has a golden, and it validates against the GitLab
 * CI schema this lexicon vendors.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";
import { greenCheckout, PR_LOOP_SETUP, prLoopJobs } from "@intentius/chant/components/pr-pipeline";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";

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
  needs?: string[];
}

describe("the GitLab merge-request pipeline", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } });
  const doc = parseYAML(result.yaml) as { workflow: { rules: unknown[] }; variables: Record<string, string>; plan: Job; record: Job; apply: Job };

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

  test("plans in a merge request pipeline from its diff base, records on a push to the default branch, applies on a ci/green/ tag, one at a time", () => {
    expect(doc.plan.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(doc.plan.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" });
    // #4295: the merge request's code runs here, so the script drops the forge tokens first.
    expect(doc.plan.script).toEqual([
      GITLAB_DROP_FORGE_TOKENS,
      ...PR_LOOP_SETUP,'chant ci run plan --in-place --no-push --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --forge gitlab']);
    expect(doc.record.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc.record.variables).toEqual({ BASE_SHA: "$CI_COMMIT_BEFORE_SHA" });
    // #4168 step 9: a pushed ci/green/ tag runs the apply, which checks out the newest green commit and reads no push base.
    expect(doc.apply.rules).toEqual([{ if: "$CI_COMMIT_TAG =~ /^ci\\/green\\//" }]);
    expect(doc.workflow.rules).toContainEqual({ if: "$CI_COMMIT_TAG =~ /^ci\\/green\\//" });
    expect(doc.apply.variables).toEqual({});
    expect(doc.apply.script.at(-2)).toBe(greenCheckout("$CI_DEFAULT_BRANCH"));
    expect(doc.apply.needs).toBeUndefined();
    // #4156: ci run builds pr-apply (with no --require-review since #4168), and GitLab hands CHANT_RUNNER_KEY to the job as a CI/CD variable when it has one.
    expect(doc.apply.script.at(-1)).toBe("chant ci run apply --in-place --env prod --gate pr-apply --forge gitlab");
    expect(result.yaml).not.toContain("CHANT_RUNNER_KEY");
    expect(doc.apply.resource_group).toBe("chant-apply-prod");
    expect(doc.variables.GIT_DEPTH).toBe("0");
    expect(doc.apply.artifacts).toEqual({ when: "always", paths: [".chant/pr"] });
  });

  test("events and reportUrl stream the run's events into the report artifact and copy the reports out (#4007)", () => {
    const loud = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, events: true, reportUrl: "$CHANT_REPORT_URL" } }).yaml) as { plan: Job; apply: Job };
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
    const own = generateGitlabPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: { applyOnMerge: true } }).yaml;
    expect(own).toContain("image: example/ci:1");
    expect(own).not.toContain("install-opentofu");
  });

  test("an all-zero CI_COMMIT_BEFORE_SHA falls back to the merge request diff base, then the target branch", () => {
    const line = doc.record.script.find((l) => l.includes("CI_MERGE_REQUEST_DIFF_BASE_SHA"))!;
    expect(line).toContain("0000000000000000000000000000000000000000");
    expect(line).toContain("git fetch origin $CI_DEFAULT_BRANCH");
    expect(doc.record.script.indexOf(line)).toBeLessThan(doc.record.script.length - 1);
    expect(doc.plan.script.some((l) => l.includes("CI_MERGE_REQUEST_DIFF_BASE_SHA"))).toBe(false);
  });

  test("a named branch replaces the default branch in the apply rule", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, branch: "trunk" } }).yaml;
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
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: { applyOnMerge: true }, promoteTo: "prod" })).toThrow(/pull-request pipeline has no promote job/);
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: { applyOnMerge: true }, gatedWaves: { gate: "g", canary: ["net"] } })).toThrow(/takes no --canary/);
  });

  test("inside a workspace member: member-named jobs that cd into the member, with no changes rule (#3465)", () => {
    const member = { name: "network", dir: "infra/network", file: ".gitlab/ci/chant-pr.network.prod.gitlab-ci.yml" };
    const scoped = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, member });
    const mdoc = parseYAML(scoped.yaml) as Record<string, unknown> & { workflow: { name?: string; rules: unknown[] } };
    expect(scoped.jobs.map((j) => j.jobName)).toEqual(["network-plan", "network-plan-note", "network-record", "network-apply"]);
    expect(mdoc.plan).toBeUndefined();
    // Included files merge top-level keys: no name, so members do not collide on it.
    expect(mdoc.workflow.name).toBeUndefined();
    expect(mdoc.workflow.rules).toHaveLength(3);
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
    expect(() => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, branch: "re$lease" } })).toThrow(/filters on branch "re\$lease"/);
  });
});

describe("the gitlab pull-request pipeline with build (#4088)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, build: true } });
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
      const i = lines.findIndex((l) => l.startsWith(`chant ci run ${job}`));
      expect(lines.slice(i - 2, i)).toEqual(["chant build --env prod", "chant lint"]);
    }
  });

  test("buildCommand replaces the build line and turns the option on", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, buildCommand: "npm run build" } }).yaml;
    expect(yaml).toContain("npm run build");
    expect(yaml).not.toContain("chant build --env");
    expect(yaml).toContain("chant lint");
  });

  test("the default output carries neither line", () => {
    const plain = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } }).yaml;
    expect(plain).not.toContain("chant lint");
  });
});

describe("the GitLab merge-request pipeline records on merge by default (#4168)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {} });
  const doc = parseYAML(result.yaml) as Record<string, unknown> & { stages: string[]; record: Job };
  const golden = join(import.meta.dirname, "__fixtures__", "pr-loop-record.gitlab.golden.yml");

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, result.yaml);
    expect(result.yaml).toBe(readFileSync(golden, "utf-8"));
  });

  test("validates against the vendored GitLab CI schema", () => {
    const req = createRequire(import.meta.url);
    const mod = req("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("a push to the default branch runs the record job, which applies nothing and keeps no cache", () => {
    expect(doc.stages).toEqual(["plan", "plan-note", "record"]);
    expect(doc.apply).toBeUndefined();
    expect(doc.record.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc.record.script.at(-1)).toBe('chant ci run record --in-place --base "$BASE_SHA" --env prod --gate pr-apply --forge gitlab');
    expect(doc.record.resource_group).toBe("chant-record-prod");
    expect(doc.record.cache).toBeUndefined();
  });

  test("a gate per wave gates the apply, so it needs applyOnMerge", () => {
    expect(() => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {}, gatedWaves: { gate: "release" } })).toThrow(/needs --apply-on-merge/);
  });

  test("inside a workspace member the record job takes the member's name and group", () => {
    const scoped = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {}, member: { name: "network", dir: "infra/network" } }).yaml) as Record<string, Job>;
    expect(scoped["network-record"].resource_group).toBe("chant-record.network.prod");
    expect(scoped["network-record"].script.at(-1)).toContain("chant ci run record");
  });
});

describe("the GitLab plan job holds no forge token while the merge request's code runs (#4295)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", image: "example/ci:1", beforeScript: ["npm ci"], prLoop: { build: true } });
  const doc = parseYAML(result.yaml) as Record<string, Job & { stage: string; rules: Array<{ if: string; when?: string }> }>;

  test("the plan's script drops the tokens first, and every later line runs without them", () => {
    const plan = doc.plan!;
    expect(plan.script[0]).toBe(GITLAB_DROP_FORGE_TOKENS);
    // GitLab runs the script in one shell: each line after the first, run there with the tokens set, sees none of them.
    const SECRET = "glpat-handover-4295";
    const tokens = { GITLAB_TOKEN: SECRET, CHANT_FORGE_TOKEN: SECRET, CHANT_GITLAB_TOKEN: SECRET, CI_JOB_TOKEN: SECRET };
    const lines = plan.script.map((line, i) => (i === 0 ? line : `env | grep -c ${SECRET} || true`));
    const out = execFileSync("sh", ["-c", lines.join("\n")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...tokens }, encoding: "utf-8" });
    expect(out.trim().split("\n").every((n) => n === "0")).toBe(true);
    expect(plan.variables).not.toHaveProperty("GITLAB_TOKEN");
    expect(prLoopJobs("gitlab", "prod")[0]!.command.endsWith(" --no-status")).toBe(true);
  });

  test("the plan-note job takes the plan's artifact, checks out the target branch's commit, and posts", () => {
    const note = doc["plan-note"]!;
    expect(note.stage).toBe("plan-note");
    expect(note.needs).toEqual(["plan"]);
    expect(note.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: "always" }]);
    expect(note.variables).toEqual({ PR_NUMBER: "$CI_MERGE_REQUEST_IID", HEAD_SHA: "$CI_COMMIT_SHA", BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA" });
    expect(note.script[0]).toBe('git checkout --quiet --detach "$BASE_SHA"');
    expect(note.script.at(-1)).toBe('chant components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge gitlab');
    // It runs no build, lint or plan: none of the merge request's code.
    expect(note.script.join("\n")).not.toMatch(/chant (build|lint|ci run)/);
    expect(result.stages).toEqual(["plan", "plan-note", "record"]);
  });
});
