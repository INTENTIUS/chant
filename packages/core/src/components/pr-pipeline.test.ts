/**
 * The apply job's base fallback (#4004), run in sh against a real
 * repository. GitHub and Forgejo set `github.event.before`, and GitLab
 * `CI_COMMIT_BEFORE_SHA`, to forty zeros on a branch's first push.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EMPTY_TREE_SHA } from "./changed-files";
import { githubBaseFallback, gitlabBaseFallback, greenCheckout, GREEN_TICK_WORKFLOW, prLoopJobs } from "./pr-pipeline";

const ZEROS = "0".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "chant-pr-base-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

/** A bare origin and a clone of it, `main` holding `commits` commits. */
function repo(name: string, commits: number): string {
  const origin = join(dir, `${name}.git`);
  const work = join(dir, name);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "remote", "add", "origin", origin);
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(work, "f.txt"), `${i}\n`);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `c${i}`);
  }
  git(work, "push", "-q", "origin", "main");
  return work;
}

/** BASE_SHA after `line` runs in `cwd` with `env`. */
function settle(cwd: string, line: string, env: Record<string, string>): string {
  return execFileSync("sh", ["-ec", `${line}\nprintf %s "$BASE_SHA"`], { cwd, encoding: "utf8", env: { ...ENV, ...env } });
}

describe("githubBaseFallback (#4004)", () => {
  test("a set base is kept", () => {
    const work = repo("kept", 2);
    const parent = git(work, "rev-parse", "HEAD^");
    expect(settle(work, githubBaseFallback(), { BASE_SHA: parent, GITHUB_SHA: git(work, "rev-parse", "HEAD") })).toBe(parent);
  });

  test("forty zeros or empty on the target branch's first push: the pushed commit's parent", () => {
    const work = repo("first", 2);
    const head = git(work, "rev-parse", "HEAD");
    const parent = git(work, "rev-parse", "HEAD^");
    expect(settle(work, githubBaseFallback(), { BASE_SHA: ZEROS, GITHUB_SHA: head })).toBe(parent);
    expect(settle(work, githubBaseFallback(), { BASE_SHA: "", GITHUB_SHA: head })).toBe(parent);
  });

  test("a branch's first push: the merge base with the target branch", () => {
    const work = repo("branch", 1);
    const fork = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "feature");
    writeFileSync(join(work, "g.txt"), "g\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "feature");
    expect(settle(work, githubBaseFallback(), { BASE_SHA: ZEROS, GITHUB_SHA: git(work, "rev-parse", "HEAD") })).toBe(fork);
  });

  test("a root commit: the empty tree", () => {
    const work = repo("root", 1);
    expect(settle(work, githubBaseFallback(), { BASE_SHA: ZEROS, GITHUB_SHA: git(work, "rev-parse", "HEAD") })).toBe(EMPTY_TREE_SHA);
  });

  test("a named branch is the one fetched", () => {
    expect(githubBaseFallback()).toContain('git fetch origin "main"');
    expect(githubBaseFallback("trunk")).toContain('git fetch origin "trunk"');
  });
});

describe("gitlabBaseFallback", () => {
  test("a root commit's first push: the empty tree, as on GitHub (#4004)", () => {
    const work = repo("gitlab-root", 1);
    expect(settle(work, gitlabBaseFallback("main"), { BASE_SHA: ZEROS, CI_COMMIT_SHA: git(work, "rev-parse", "HEAD") })).toBe(EMPTY_TREE_SHA);
  });

  test("the merge request's diff base comes first", () => {
    const work = repo("gitlab-mr", 2);
    const parent = git(work, "rev-parse", "HEAD^");
    expect(settle(work, gitlabBaseFallback("main"), { BASE_SHA: ZEROS, CI_MERGE_REQUEST_DIFF_BASE_SHA: parent, CI_COMMIT_SHA: git(work, "rev-parse", "HEAD") })).toBe(parent);
  });
});

describe("prLoopJobs", () => {
  test("every forge's record settles its base first; no plan does, and the apply checks out the newest green commit (#4168 step 9)", () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const [plan, apply, record] = prLoopJobs(forge, "prod", { branch: "trunk" });
      expect(plan!.setup).toBeUndefined();
      expect(record!.setup).toEqual([forge === "gitlab" ? gitlabBaseFallback("trunk") : githubBaseFallback("trunk")]);
      expect(apply!.setup).toBeUndefined();
      expect(apply!.checkout).toEqual([greenCheckout('"trunk"')]);
      expect(apply!.env).not.toHaveProperty("BASE_SHA");
      expect(apply!.command).toContain("pr-apply --green");
      expect(apply!.run.command).not.toContain("--base");
    }
  });

  test("the green tick workflow's name is the one ci workflow writes", async () => {
    const { CI_GREEN_WORKFLOW_NAME } = await import("../workspace/ci-green-workflow");
    expect(GREEN_TICK_WORKFLOW).toBe(CI_GREEN_WORKFLOW_NAME);
  });
});
