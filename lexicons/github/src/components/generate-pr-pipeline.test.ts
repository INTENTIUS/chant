/**
 * The generated pull-request workflow for GitHub Actions (#3183): a plan job
 * on each pull request, an apply job on each push to the target branch. The
 * whole file has a golden, and actionlint checks it when it is installed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { githubBaseFallback, greenCheckout, prApplyGroup, prApplyRecordKey, prLoopJobs } from "@intentius/chant/components/pr-pipeline";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop.github.golden.yml");

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if: string;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  steps: Step[];
}

describe("the GitHub pull-request workflow", () => {
  const result = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } });
  const doc = parseYAML(result.yaml) as { name: string; on: Record<string, unknown>; jobs: Record<string, Job> };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("plans on a pull request into main, records on a push to it, and applies once the tick ran (#4168 step 9)", () => {
    expect(doc.name).toBe("chant-pr-prod");
    // A tag the tick pushes with the job token starts no workflow, so the apply follows the tick's workflow instead.
    expect(doc.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] }, workflow_run: { workflows: ["chant-ci-green"], types: ["completed"] }, workflow_dispatch: {} });
    expect(doc.jobs.plan.if).toBe("github.event_name == 'pull_request'");
    expect(doc.jobs.record.if).toBe("github.event_name == 'push'");
    expect(doc.jobs.apply.if).toBe("github.event_name == 'workflow_run' || github.event_name == 'workflow_dispatch'");
    expect(result.jobs.map((j) => j.jobName)).toEqual(["plan", "record", "apply"]);
    expect(result.jobs.find((j) => j.jobName === "apply")!.needs).toEqual([]);
  });

  test("the plan job measures from the pull request's base and cannot push; the apply job can, one at a time", () => {
    const plan = doc.jobs.plan.steps.find((s) => s.run?.includes("ci run plan"))!;
    // #4156: the job runs pr-plan through chant ci run, in its own checkout, and pushes no record from the pull request's code.
    expect(plan.run).toBe('chant ci run plan --in-place --no-push --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --forge github');
    expect(plan.env).toMatchObject({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}" });
    // The runner key is an optional secret: unset, the expression is empty and the record is unsigned.
    expect(plan.env?.CHANT_RUNNER_KEY).toBe("${{ secrets.CHANT_RUNNER_KEY }}");
    expect(doc.jobs.plan.permissions).toEqual({ actions: "read", contents: "read", "pull-requests": "write", statuses: "write" });

    const apply = doc.jobs.apply.steps.find((s) => s.run?.includes("ci run apply"))!;
    // #4168: ci run builds pr-apply without --require-review unless the pipeline asks for it.
    expect(apply.run).not.toContain("--require-review");
    expect(apply.run).not.toContain("--no-push");
    // #4168 step 9: the apply measures from the last applied green commit, so it reads no push base.
    expect(apply.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", CHANT_RUNNER_KEY: "${{ secrets.CHANT_RUNNER_KEY }}" });
    expect(doc.jobs.apply.permissions.contents).toBe("write");
    expect(doc.jobs.apply.concurrency).toEqual({ group: "chant-apply-prod", "cancel-in-progress": false });
    for (const job of Object.values(doc.jobs)) expect(job.steps[0].with).toEqual({ "fetch-depth": 0 });
  });

  test("a first push's all-zero github.event.before is settled in the record's own shell, before pr-record reads it (#4004)", () => {
    const record = doc.jobs.record.steps.find((s) => s.run?.includes("ci run record"))!;
    const lines = record.run!.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(githubBaseFallback());
    expect(lines[0]).toContain('[ "$BASE_SHA" = "0000000000000000000000000000000000000000" ]');
    expect(lines[0]).toContain('git merge-base FETCH_HEAD "$GITHUB_SHA"');
    expect(lines[1]).toMatch(/^chant ci run record --in-place --base "\$BASE_SHA"/);
    const plan = doc.jobs.plan.steps.find((s) => s.run?.includes("ci run plan"))!;
    expect(plan.run).not.toContain("0000000000000000000000000000000000000000");
  });

  test("the apply checks out the newest green commit of the branch before it runs (#4168 step 9)", () => {
    const apply = doc.jobs.apply.steps.find((s) => s.run?.includes("ci run apply"))!;
    const lines = apply.run!.trimEnd().split("\n");
    expect(lines).toEqual([greenCheckout('"main"'), "chant ci run apply --in-place --env prod --gate pr-apply --forge github"]);
    expect(lines[0]).toContain('GREEN_SHA="$(chant ci last-green)"');
    const trunk = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, branch: "trunk" } }).yaml) as { jobs: Record<string, Job> };
    expect(trunk.jobs.apply.steps.find((s) => s.run?.includes("ci run apply"))!.run).toContain('"+refs/heads/trunk:refs/remotes/origin/trunk"');
    expect(prLoopJobs("github", "prod")[1]!.command).toMatch(/^chant components pr-apply --green /);
  });

  test("the apply resumes from a record the cache keeps for the pushed commit across a re-run (#3543)", () => {
    const steps = doc.jobs.apply.steps;
    const restore = steps.findIndex((s) => s.uses === "actions/cache/restore@v4");
    const run = steps.findIndex((s) => s.run?.includes("ci run apply"));
    const save = steps.findIndex((s) => s.uses === "actions/cache/save@v4");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(run);
    expect(save).toBeGreaterThan(run);
    // ci run runs the inner pr-apply in the checkout, where the cache restored the record.
    expect(steps[run].run).toContain("--in-place");
    expect(prLoopJobs("github", "prod")[1]!.command).toContain("--resume .chant/pr-resume/pr-apply.json");
    const key = "chant-apply-prod-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}";
    expect(steps[restore].with).toEqual({ path: ".chant/pr-resume/pr-apply.json", key, "restore-keys": "chant-apply-prod-${{ github.sha }}-" });
    // Saved even when the apply failed, which is when a re-run needs it.
    expect(steps[save].if).toBe("always()");
    expect(steps[save].with).toEqual({ path: ".chant/pr-resume/pr-apply.json", key });
    // The plan job runs the pull request's code: it neither reads nor writes the record.
    expect(doc.jobs.plan.steps.some((s) => s.uses?.startsWith("actions/cache"))).toBe(false);
    expect(doc.jobs.plan.steps.find((s) => s.run?.includes("ci run plan"))!.run).not.toContain("--resume");
    // The report artifact does not carry the record, which holds the members' outputs.
    const keep = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(keep.with?.path).toBe(".chant/pr");
  });

  test("runs in an image with git and installs OpenTofu, unless the caller names an image", () => {
    expect(doc.jobs.plan.steps[1].run).toContain("install-opentofu");
    const own = generateGithubPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: { applyOnMerge: true } }).yaml;
    expect(own).toContain("container: example/ci:1");
    expect(own).not.toContain("install-opentofu");
  });

  test("the gate, branch and review requirement are options", () => {
    const yaml = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, gate: "infra-apply", branch: "trunk", requireReview: true } }).yaml;
    expect(yaml).toContain("--gate infra-apply");
    expect(yaml).toContain("- trunk");
    expect(yaml).toContain("ci run apply --in-place --env prod --gate infra-apply --forge github --branch \"trunk\" --require-review");
    expect(yaml).toContain('--branch "trunk"');
  });

  test("refuses a promote job beside it, and a canary or a fixed base beside --wave-gate (#4003)", () => {
    expect(() => generateGithubPipeline(ESTATE, { prLoop: { applyOnMerge: true }, promoteTo: "prod" })).toThrow(/pull-request pipeline has no promote job/);
    expect(() => generateGithubPipeline(ESTATE, { prLoop: { applyOnMerge: true }, gatedWaves: { gate: "g", canary: ["net"] } })).toThrow(/takes no --canary/);
    expect(() => generateGithubPipeline(ESTATE, { prLoop: { applyOnMerge: true }, gatedWaves: { gate: "g", base: "HEAD~1" } })).toThrow(/takes no --base/);
  });

  test("events and reportUrl stream the run's events into the report artifact and copy the reports out (#4007)", () => {
    const loud = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, events: true, reportUrl: "s3://chant-reports/acme" } }).yaml) as { jobs: Record<string, Job> };
    for (const job of ["plan", "apply"]) {
      const run = loud.jobs[job].steps.find((s) => s.run?.includes("chant ci run"))!;
      expect(run.run).toContain('--events-json --report-url "s3://chant-reports/acme"');
      expect(run.env?.CHANT_RUN_EVENTS_DIR).toBe(".chant/pr/run-events");
    }
    // Off by default: the golden carries neither.
    expect(result.yaml).not.toContain("--events-json");
    expect(result.yaml).not.toContain("CHANT_RUN_EVENTS_DIR");
  });

  test("inside a workspace member: runs in the member's directory and keeps its own gate, note and apply group (#3465)", () => {
    const member = { name: "network", dir: "infra/network", file: ".github/workflows/chant-pr.network.prod.yml" };
    const scoped = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, member });
    const mdoc = parseYAML(scoped.yaml) as {
      name: string;
      on: Record<string, unknown>;
      defaults?: { run: Record<string, string> };
      jobs: Record<string, Job>;
    };
    expect(mdoc.name).toBe("chant-pr.network.prod");
    // No path filter: a change outside the member can reach it.
    expect(mdoc.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] }, workflow_run: { workflows: ["chant-ci-green"], types: ["completed"] }, workflow_dispatch: {} });
    expect(mdoc.defaults).toEqual({ run: { "working-directory": "infra/network" } });
    const plan = mdoc.jobs.plan.steps.find((s) => s.run?.includes("ci run plan"))!;
    // ci run finds the member from the directory it runs in and passes --member to pr-plan and pr-apply.
    expect(plan.run).toBe('chant ci run plan --in-place --no-push --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --forge github');
    expect(prLoopJobs("github", "prod", {}, "network")[0]!.command).toContain("--member network");
    const apply = mdoc.jobs.apply.steps.find((s) => s.run?.includes("ci run apply"))!;
    expect(mdoc.jobs.apply.concurrency).toEqual({ group: "chant-apply.network.prod", "cancel-in-progress": false });
    // The record path is relative to the member for --resume and to the repository for the cache.
    expect(apply.run).toContain("--in-place");
    const restore = mdoc.jobs.apply.steps.find((s) => s.uses === "actions/cache/restore@v4")!;
    expect(restore.with).toMatchObject({ path: "infra/network/.chant/pr-resume/pr-apply.json", "restore-keys": "chant-apply.network.prod-${{ github.sha }}-" });
    for (const job of Object.values(mdoc.jobs)) {
      const keep = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
      expect(keep.with?.path).toBe("infra/network/.chant/pr");
    }
  });

  test("no two member and environment pairs share an apply group or record key", () => {
    expect(prApplyGroup("b-c", "a")).toBe("chant-apply.a.b-c");
    expect(prApplyGroup("c", "a-b")).toBe("chant-apply.a-b.c");
    expect(prApplyGroup("b-c", "a")).not.toBe(prApplyGroup("c", "a-b"));
    expect(prApplyRecordKey("b-c", "abc", "a")).not.toBe(prApplyRecordKey("c", "abc", "a-b"));
    // A single project's group never looks like a member's.
    expect(prApplyGroup("a-b-c")).toBe("chant-apply-a-b-c");
    expect(prApplyGroup("a.b-c")).not.toBe(prApplyGroup("b-c", "a"));
  });

  test("a member at the workspace root keeps the root's paths but its own names", () => {
    const yaml = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, member: { name: "root", dir: "." } }).yaml;
    const mdoc = parseYAML(yaml) as { name: string; defaults?: unknown; jobs: Record<string, Job> };
    expect(mdoc.name).toBe("chant-pr.root.prod");
    expect(mdoc.defaults).toBeUndefined();
    expect(yaml).toContain("chant ci run plan --in-place");
    expect(yaml).toContain("path: .chant/pr");
  });

  test.skipIf(!hasActionlint())("passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-actionlint-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), result.yaml);
      expect(() => execFileSync("actionlint", [".github/workflows/chant-pr.yml"], { cwd: dir, encoding: "utf8" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the github pull-request pipeline with build (#4088)", () => {
  const result = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, build: true } });
  const doc = parseYAML(result.yaml) as Record<string, any>;
  const golden = join(import.meta.dirname, "__fixtures__", "pr-loop-build.github.golden.yml");

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, result.yaml);
    expect(result.yaml).toBe(readFileSync(golden, "utf-8"));
  });

  test("builds, then lints, before pr-plan and pr-apply", () => {
    for (const job of ["plan", "apply"]) {
      const runs = doc.jobs[job].steps.map((s: { run?: string }) => s.run ?? "").filter(Boolean);
      const i = runs.findIndex((r: string) => r.startsWith("chant components pr-"));
      expect(runs.slice(i - 2, i)).toEqual(["chant build --env prod", "chant lint"]);
    }
  });

  test("buildCommand replaces the build line and turns the option on", () => {
    const yaml = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, buildCommand: "npm run build" } }).yaml;
    expect(yaml).toContain("npm run build");
    expect(yaml).not.toContain("chant build --env");
    expect(yaml).toContain("chant lint");
  });

  test("the default output carries neither line", () => {
    const plain = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } }).yaml;
    expect(plain).not.toContain("chant lint");
  });
});

describe("the GitHub pull-request workflow records on merge by default (#4168)", () => {
  const result = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {} });
  const doc = parseYAML(result.yaml) as { jobs: Record<string, Job> };
  const golden = join(import.meta.dirname, "__fixtures__", "pr-loop-record.github.golden.yml");

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, result.yaml);
    expect(result.yaml).toBe(readFileSync(golden, "utf-8"));
  });

  test("a push runs the record job, which applies nothing and keeps no resume record", () => {
    expect(result.jobs.map((j) => j.jobName)).toEqual(["plan", "record"]);
    expect(doc.jobs.apply).toBeUndefined();
    expect(doc.jobs.record.if).toBe("github.event_name == 'push'");
    const run = doc.jobs.record.steps.find((s) => s.run?.includes("ci run record"))!;
    expect(run.run!.trimEnd().split("\n")).toEqual([githubBaseFallback(), 'chant ci run record --in-place --base "$BASE_SHA" --env prod --gate pr-apply --forge github']);
    expect(doc.jobs.record.steps.some((s) => s.uses?.startsWith("actions/cache"))).toBe(false);
    // It writes the merge record and the change set to chant/lifecycle, one at a time per environment.
    expect(doc.jobs.record.permissions.contents).toBe("write");
    expect(doc.jobs.record.concurrency).toEqual({ group: "chant-record-prod", "cancel-in-progress": false });
    expect(result.yaml).not.toContain("ci run apply");
  });

  test("a gate per wave gates the apply, so it needs applyOnMerge", () => {
    expect(() => generateGithubPipeline(ESTATE, { env: "prod", prLoop: {}, gatedWaves: { gate: "release" } })).toThrow(/needs --apply-on-merge/);
  });

  test("the record job runs pr-record with the apply's flags", () => {
    const [, , record] = prLoopJobs("github", "prod", { events: true, reportUrl: "s3://r/acme", waveGate: "w", requireReview: true, branch: "trunk" });
    expect(record.jobName).toBe("record");
    expect(record.command).toBe('chant components pr-record --base "$BASE_SHA" --env prod --gate pr-apply --output .chant/pr --forge github --events-json --report-url "s3://r/acme"');
    expect(record.run.command).toBe('chant ci run record --in-place --base "$BASE_SHA" --env prod --gate pr-apply --forge github --branch "trunk" --events-json --report-url "s3://r/acme"');
  });

  test.skipIf(!hasActionlint())("passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pr-record-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), result.yaml);
      execFileSync("actionlint", [join(dir, ".github", "workflows", "chant-pr.yml")], { cwd: dir, stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
