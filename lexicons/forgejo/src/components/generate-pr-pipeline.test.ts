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
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
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

  test("its commands talk to Forgejo, on Forgejo's runner, with the job permissions dropped", () => {
    expect(result.yaml).toContain("--forge forgejo");
    expect(result.yaml).not.toContain("--forge github");
    expect(result.yaml).toContain("runs-on: docker");
    expect(result.yaml).not.toMatch(/^\s*permissions:/m);
  });

  test("events and reportUrl reach Forgejo's jobs as they reach GitHub's (#4007)", () => {
    const yaml = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { events: true, reportUrl: "file:///srv/chant-reports" } }).yaml;
    expect(yaml.match(/--forge forgejo --events-json --report-url "file:\/\/\/srv\/chant-reports"/g)).toHaveLength(2);
    expect(yaml.match(/CHANT_RUN_EVENTS_DIR: \.chant\/pr\/run-events/g)).toHaveLength(2);
  });

  test("the apply keeps its resume record in the runner's cache, through the Forgejo mirror of actions/cache (#3543)", () => {
    expect(result.yaml).toContain("uses: https://code.forgejo.org/actions/cache/restore@v4");
    expect(result.yaml).toContain("uses: https://code.forgejo.org/actions/cache/save@v4");
    expect(result.yaml).toContain("--forge forgejo --require-review --resume .chant/pr-resume/pr-apply.json");
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
