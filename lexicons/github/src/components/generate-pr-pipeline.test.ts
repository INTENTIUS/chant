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
  const result = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {} });
  const doc = parseYAML(result.yaml) as { name: string; on: Record<string, unknown>; jobs: Record<string, Job> };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("plans on a pull request into main and applies on a push to it", () => {
    expect(doc.name).toBe("chant-pr-prod");
    expect(doc.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] } });
    expect(doc.jobs.plan.if).toBe("github.event_name == 'pull_request'");
    expect(doc.jobs.apply.if).toBe("github.event_name == 'push'");
    expect(result.jobs.map((j) => j.jobName)).toEqual(["plan", "apply"]);
  });

  test("the plan job measures from the pull request's base and cannot push; the apply job can, one at a time", () => {
    const plan = doc.jobs.plan.steps.find((s) => s.run?.includes("pr-plan"))!;
    expect(plan.run).toBe('chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --output .chant/pr --forge github');
    expect(plan.env).toMatchObject({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(doc.jobs.plan.permissions).toEqual({ contents: "read", "pull-requests": "write", statuses: "write" });

    const apply = doc.jobs.apply.steps.find((s) => s.run?.includes("pr-apply"))!;
    expect(apply.run).toContain("--require-review");
    expect(apply.env).toMatchObject({ BASE_SHA: "${{ github.event.before }}" });
    expect(doc.jobs.apply.permissions.contents).toBe("write");
    expect(doc.jobs.apply.concurrency).toEqual({ group: "chant-apply-prod", "cancel-in-progress": false });
    for (const job of Object.values(doc.jobs)) expect(job.steps[0].with).toEqual({ "fetch-depth": 0 });
  });

  test("runs in an image with git and installs OpenTofu, unless the caller names an image", () => {
    expect(doc.jobs.plan.steps[1].run).toContain("install-opentofu");
    const own = generateGithubPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: {} }).yaml;
    expect(own).toContain("container: example/ci:1");
    expect(own).not.toContain("install-opentofu");
  });

  test("the gate, branch and review requirement are options", () => {
    const yaml = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { gate: "infra-apply", branch: "trunk", requireReview: false } }).yaml;
    expect(yaml).toContain("--gate infra-apply");
    expect(yaml).toContain("- trunk");
    expect(yaml).not.toContain("--require-review");
  });

  test("refuses a wave or promote job beside it", () => {
    expect(() => generateGithubPipeline(ESTATE, { prLoop: {}, gatedWaves: { gate: "g" } })).toThrow(/pull-request pipeline has no wave or promote jobs/);
    expect(() => generateGithubPipeline(ESTATE, { prLoop: {}, promoteTo: "prod" })).toThrow(/pull-request pipeline has no wave or promote jobs/);
  });

  test("inside a workspace member: runs in the member's directory and keeps its own gate, note and apply group (#3465)", () => {
    const member = { name: "network", dir: "infra/network", file: ".github/workflows/chant-pr-network-prod.yml" };
    const scoped = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {}, member });
    const mdoc = parseYAML(scoped.yaml) as {
      name: string;
      on: Record<string, unknown>;
      defaults?: { run: Record<string, string> };
      jobs: Record<string, Job>;
    };
    expect(mdoc.name).toBe("chant-pr-network-prod");
    // No path filter: a change outside the member can reach it.
    expect(mdoc.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] } });
    expect(mdoc.defaults).toEqual({ run: { "working-directory": "infra/network" } });
    const plan = mdoc.jobs.plan.steps.find((s) => s.run?.includes("pr-plan"))!;
    expect(plan.run).toBe('chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --output .chant/pr --forge github --member network');
    const apply = mdoc.jobs.apply.steps.find((s) => s.run?.includes("pr-apply"))!;
    expect(apply.run).toContain("--member network");
    expect(mdoc.jobs.apply.concurrency).toEqual({ group: "chant-apply-network-prod", "cancel-in-progress": false });
    for (const job of Object.values(mdoc.jobs)) {
      const keep = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
      expect(keep.with?.path).toBe("infra/network/.chant/pr");
    }
  });

  test("a member at the workspace root keeps the root's paths but its own names", () => {
    const yaml = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {}, member: { name: "root", dir: "." } }).yaml;
    const mdoc = parseYAML(yaml) as { name: string; defaults?: unknown; jobs: Record<string, Job> };
    expect(mdoc.name).toBe("chant-pr-root-prod");
    expect(mdoc.defaults).toBeUndefined();
    expect(yaml).toContain("--member root");
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
