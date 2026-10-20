/**
 * The generated pull-request workflow for Forgejo Actions (#3183): github's
 * workflow with the Forgejo dialect applied and its commands talking to
 * Forgejo. The whole file has a golden, and actionlint checks it when it is
 * installed, less the two things it cannot know about Forgejo: the runner
 * label and actions referenced by URL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { githubBaseFallback } from "@intentius/chant/components/pr-pipeline";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop.forgejo.golden.yml");

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the Forgejo pull-request workflow", () => {
  const result = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: {} });

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("both jobs run chant ci run with the runner key secret, as on GitHub (#4156)", () => {
    expect(result.yaml).toContain("chant ci run plan --in-place --no-push");
    expect(result.yaml.match(/CHANT_RUNNER_KEY: '\$\{\{ secrets\.CHANT_RUNNER_KEY \}\}'/g)).toHaveLength(2);
    expect(result.yaml).not.toContain("chant components pr-");
  });

  test("its commands talk to Forgejo, on Forgejo's runner, with the job permissions dropped", () => {
    expect(result.yaml).toContain("--forge forgejo");
    expect(result.yaml).not.toContain("--forge github");
    expect(result.yaml).toContain("runs-on: docker");
    expect(result.yaml).not.toMatch(/^\s*permissions:/m);
  });

  test("a first push's all-zero github.event.before is settled before pr-apply reads it, as on GitHub (#4004)", () => {
    const doc = parseYAML(result.yaml) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const apply = doc.jobs.apply!.steps.find((s) => s.run?.includes("ci run apply"))!.run!.trimEnd().split("\n");
    expect(apply[0]).toBe(githubBaseFallback());
    expect(apply[0]).toContain('git merge-base FETCH_HEAD "$GITHUB_SHA"');
    expect(apply[1]).toMatch(/^chant ci run apply --in-place --base "\$BASE_SHA"/);
    expect(doc.jobs.plan!.steps.find((s) => s.run?.includes("ci run plan"))!.run).not.toContain("0000000000000000000000000000000000000000");
  });

  test("events and reportUrl reach Forgejo's jobs as they reach GitHub's (#4007)", () => {
    const yaml = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { events: true, reportUrl: "file:///srv/chant-reports" } }).yaml;
    expect(yaml.match(/--forge forgejo --events-json --report-url "file:\/\/\/srv\/chant-reports"/g)).toHaveLength(2);
    expect(yaml.match(/CHANT_RUN_EVENTS_DIR: \.chant\/pr\/run-events/g)).toHaveLength(2);
  });

  test("the apply keeps its resume record in the runner's cache, through the Forgejo mirror of actions/cache (#3543)", () => {
    expect(result.yaml).toContain("uses: https://code.forgejo.org/actions/cache/restore@v4");
    expect(result.yaml).toContain("uses: https://code.forgejo.org/actions/cache/save@v4");
    // ci run's inner pr-apply resumes from it (#4156): the job runs in place, where the cache restored it.
    expect(result.yaml).toContain("chant ci run apply --in-place --base");
  });

  test("keeps its reports with upload-artifact v3, the version a Forgejo runner runs, while GitHub keeps v4 (#4008)", () => {
    // v4 refuses a runner that reads as GitHub Enterprise Server, as Forgejo's does.
    expect(result.yaml.match(/uses: https:\/\/code\.forgejo\.org\/actions\/upload-artifact@v3$/gm)).toHaveLength(2);
    expect(result.yaml).not.toMatch(/(upload|download)-artifact@v4/);
    // v3 uploads hidden files with no input asking for it, so .chant/pr is still kept.
    expect(result.yaml).not.toContain("include-hidden-files");
    expect(result.yaml).toContain("path: .chant/pr");
    const github = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml;
    expect(github.match(/uses: actions\/upload-artifact@v4$/gm)).toHaveLength(2);
    expect(github).toContain("include-hidden-files: true");
  });

  test.skipIf(!hasActionlint())("passes actionlint, less the runner label and actions by URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-actionlint-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), result.yaml);
      const ignore = ['label "docker" is unknown', "invalid format because owner and repo and ref should not be empty"];
      expect(() =>
        execFileSync("actionlint", [...ignore.flatMap((p) => ["-ignore", p]), ".github/workflows/chant-pr.yml"], { cwd: dir, encoding: "utf8" }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the forgejo pull-request pipeline with build (#4088)", () => {
  const result = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { build: true } });
  const doc = parseYAML(result.yaml) as Record<string, any>;
  const golden = join(import.meta.dirname, "__fixtures__", "pr-loop-build.forgejo.golden.yml");

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
    const yaml = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { buildCommand: "npm run build" } }).yaml;
    expect(yaml).toContain("npm run build");
    expect(yaml).not.toContain("chant build --env");
    expect(yaml).toContain("chant lint");
  });

  test("the default output carries neither line", () => {
    const plain = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml;
    expect(plain).not.toContain("chant lint");
  });
});
