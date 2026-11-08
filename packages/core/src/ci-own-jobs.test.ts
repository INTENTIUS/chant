/**
 * A repository's own jobs in the pipeline file chant generates (#4769): a
 * jobs file merged after chant's jobs, and the old file's hand-added jobs
 * kept across regeneration.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isGeneratedJob, jobNames, keepOwnJobs, mergeOwnJobs, OWN_JOBS_LINE, OwnJobsError, readOwnJobsFile } from "./ci-own-jobs";
import * as ciProduct from "./ci-product";
import { NEXT_RELEASE } from "./release-floors";

const GITHUB = ["name: chant", "on:", "  pull_request:", "jobs:", "  plan:", "    runs-on: ubuntu-latest", "    steps:", "      - run: chant components pr-plan prod", "  plan-note:", "    runs-on: ubuntu-latest", "    steps:", "      - run: chant components pr-post prod", ""].join("\n");
const GITLAB = ["stages:", "  - plan", "variables:", "  A: b", "plan:", "  stage: plan", "  script:", "    - chant components pr-plan prod", ""].join("\n");

describe("mergeOwnJobs", () => {
  test("puts the jobs after chant's, under the line, on GitHub and Forgejo", () => {
    const out = mergeOwnJobs(GITHUB, "github", { lint: { "runs-on": "ubuntu-latest", steps: [{ run: "npm run lint" }] } });
    expect(out).toBe(GITHUB + ["  " + OWN_JOBS_LINE, "  lint:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm run lint", ""].join("\n"));
    expect(jobNames(out, "forgejo")).toEqual(["plan", "plan-note", "lint"]);
  });

  test("puts them inside jobs: when a key follows it", () => {
    const text = GITHUB.replace(/\n$/, "") + "\nenv:\n  A: b\n";
    const out = mergeOwnJobs(text, "github", { lint: { "runs-on": "x" } }, { line: "# mine" });
    expect(out).toContain("      - run: chant components pr-post prod\n  # mine\n  lint:\n    runs-on: x\nenv:\n  A: b\n");
  });

  test("puts them at the top level on GitLab", () => {
    expect(mergeOwnJobs(GITLAB, "gitlab", { lint: { script: ["npm run lint"] } })).toBe(GITLAB + [OWN_JOBS_LINE, "lint:", "  script:", "    - npm run lint", ""].join("\n"));
  });

  test("refuses a name chant's file has, and a GitLab keyword", () => {
    expect(() => mergeOwnJobs(GITHUB, "github", { plan: { "runs-on": "x" } })).toThrow(OwnJobsError);
    expect(() => mergeOwnJobs(GITHUB, "github", { plan: { "runs-on": "x" } }, { where: "own.yml" })).toThrow(/own\.yml\.plan: chant's file has a job of that name/);
    for (const name of ["variables", "workflow", "default", "pages"]) {
      expect(() => mergeOwnJobs(GITLAB, "gitlab", { [name]: { script: ["x"] } })).toThrow(/GitLab reads .* as a keyword/);
    }
    // On GitHub a top-level GitLab keyword is a name like any other.
    expect(mergeOwnJobs(GITHUB, "github", { variables: { "runs-on": "x" } })).toContain("  variables:\n");
  });

  test("an empty map, or none, leaves the file byte for byte", () => {
    expect(mergeOwnJobs(GITHUB, "github", {})).toBe(GITHUB);
    expect(mergeOwnJobs(GITLAB, "gitlab", undefined)).toBe(GITLAB);
  });
});

describe("readOwnJobsFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "chant-own-jobs-"));

  test("reads a map of jobs", () => {
    writeFileSync(join(dir, "ok.yml"), "lint:\n  runs-on: x\n");
    expect(readOwnJobsFile(join(dir, "ok.yml"))).toEqual({ lint: { "runs-on": "x" } });
  });

  test("refuses a missing file, a list and an empty job", () => {
    expect(() => readOwnJobsFile(join(dir, "none.yml"), "none.yml")).toThrow(/none\.yml: no such file/);
    writeFileSync(join(dir, "list.yml"), "- a\n");
    expect(() => readOwnJobsFile(join(dir, "list.yml"), "list.yml")).toThrow(/must be a map of job name to job/);
    writeFileSync(join(dir, "empty.yml"), "lint: {}\n");
    expect(() => readOwnJobsFile(join(dir, "empty.yml"), "empty.yml")).toThrow(/empty\.yml\.lint must be a job/);
  });
});

describe("keepOwnJobs", () => {
  const own = ["  # The team's own check.", "  audit:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm audit   # as written"].join("\n");
  const previous = GITHUB.replace("  plan-note:", own + "\n  plan-note:");

  test("keeps a hand-added job as written, after chant's, and keeps it again the next time", () => {
    const first = keepOwnJobs(previous, GITHUB, "github");
    expect(first.kept).toEqual(["audit"]);
    expect(first.text).toBe(GITHUB + ["  " + OWN_JOBS_LINE, "  audit:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm audit   # as written", ""].join("\n"));
    expect(keepOwnJobs(first.text, GITHUB, "github").text).toBe(first.text);
  });

  test("drops a job that runs chant or the product's bin, and one the new file has", () => {
    const old = previous + ["  old-plan:", "    steps:", "      - run: npx --no-install plywood ci run plan", "  older:", "    steps:", "      - run: plywood components pr-plan", "  gone:", "    steps:", "      - run: chant lock"].join("\n") + "\n";
    expect(keepOwnJobs(old, GITHUB, "github", { bins: ["npx --no-install plywood"] }).kept).toEqual(["audit"]);
    // Without the bin, plywood's lines are the team's own.
    expect(keepOwnJobs(old, GITHUB, "github").kept).toEqual(["audit", "old-plan", "older"]);
  });

  test("on GitLab keeps top-level jobs and never a keyword", () => {
    const old = GITLAB + "cache:\n  key: x\nlint:\n  script:\n    - npm run lint\n";
    const kept = keepOwnJobs(old, GITLAB, "gitlab");
    expect(kept.kept).toEqual(["lint"]);
    expect(kept.text).toBe(GITLAB + `${OWN_JOBS_LINE}\nlint:\n  script:\n    - npm run lint\n`);
  });

  test("no old file, or no own job in it, leaves the file byte for byte", () => {
    expect(keepOwnJobs(undefined, GITHUB, "github")).toEqual({ text: GITHUB, kept: [] });
    expect(keepOwnJobs(GITHUB, GITHUB, "github")).toEqual({ text: GITHUB, kept: [] });
  });

  test("a job counts as generated by its chant or bin line, not by a word in a path", () => {
    expect(isGeneratedJob("    - run: npm i @intentius/chant\n")).toBe(false);
    expect(isGeneratedJob('    - run: "chant components pr-plan"')).toBe(true);
    expect(isGeneratedJob("    - run: $(npm bin)/yodel plan", ["npx yodel"])).toBe(false);
    expect(isGeneratedJob("    - run: yodel plan", ["npx yodel"])).toBe(true);
  });
});

test("the ci-product entry carries both, and OWN_JOBS_FLOOR marks them", () => {
  expect(ciProduct.OWN_JOBS_FLOOR).toBe(NEXT_RELEASE);
  expect(typeof ciProduct.mergeOwnJobs).toBe("function");
  expect(typeof ciProduct.keepOwnJobs).toBe("function");
});
