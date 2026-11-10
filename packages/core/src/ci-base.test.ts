/** #4966: the base a CI job measures a change from, and `chant ci check`'s default `--base`. */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ciBaseRef } from "./ci-base";
import type { CommandContext } from "./cli/registry";
import { runCiCheck } from "./cli/handlers/ci-check";

describe("ciBaseRef", () => {
  test("a pull request's target branch, on GitHub and Forgejo, and on GitLab", () => {
    expect(ciBaseRef({ GITHUB_BASE_REF: "main", GITHUB_REF_NAME: "12/merge" })).toBe("origin/main");
    expect(ciBaseRef({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "release", CI_COMMIT_BRANCH: "feature" })).toBe("origin/release");
  });

  test("a push to another branch than the default is measured from the default branch", () => {
    expect(ciBaseRef({ GITHUB_REF_NAME: "feature" }, { defaultBranch: "main" })).toBe("origin/main");
    expect(ciBaseRef({ CI_COMMIT_BRANCH: "feature", CI_DEFAULT_BRANCH: "trunk" })).toBe("origin/trunk");
    expect(ciBaseRef({ CI_COMMIT_BRANCH: "feature", CI_DEFAULT_BRANCH: "trunk" }, { remote: "upstream" })).toBe("upstream/trunk");
  });

  test("a push to the default branch, or a job that names no default branch, has no base", () => {
    expect(ciBaseRef({ GITHUB_REF_NAME: "main" }, { defaultBranch: "main" })).toBeUndefined();
    expect(ciBaseRef({ GITHUB_REF_NAME: "feature" })).toBeUndefined();
    expect(ciBaseRef({})).toBeUndefined();
  });

  test("a base the caller has wins, and blanks count as unset", () => {
    expect(ciBaseRef({ GITHUB_BASE_REF: "main" }, { base: "HEAD^" })).toBe("HEAD^");
    expect(ciBaseRef({ GITHUB_BASE_REF: " ", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }, { base: " " })).toBe("origin/main");
  });
});

describe("chant ci check with no --base", () => {
  afterEach(() => vi.restoreAllMocks());

  test("refuses when the job names no base either", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    const ctx = { args: { positionals: ["ci", "check"] }, plugins: [], serializers: [] } as unknown as CommandContext;
    expect(await runCiCheck(ctx, { GITHUB_REF_NAME: "main" })).toBe(1);
    expect(errors.join("\n")).toContain("the job names no pull request target or default branch to take it from");
  });
});
