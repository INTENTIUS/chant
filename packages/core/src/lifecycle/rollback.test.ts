import { describe, test, expect } from "vitest";
import { rollbackBranchName, rollbackTitle, rollbackBody, rollbackToRevision } from "./rollback";

describe("rollback helpers (#873)", () => {
  test("branch name includes env and short ref", () => {
    expect(rollbackBranchName("prod", "a1b2c3d")).toBe("chant/rollback-prod-a1b2c3d");
  });

  test("branch name falls back to 'src' when env is absent", () => {
    expect(rollbackBranchName(undefined, "a1b2c3d")).toBe("chant/rollback-src-a1b2c3d");
  });

  test("title names the env and ref", () => {
    expect(rollbackTitle("prod", "v1.2.0")).toBe("rollback prod source to v1.2.0");
    expect(rollbackTitle(undefined, "v1.2.0")).toBe("rollback source to v1.2.0");
  });

  test("body references the sourceDir, ref, and the gated-apply step", () => {
    const body = rollbackBody("prod", "abc123", "src");
    expect(body).toContain("`src`");
    expect(body).toContain("`abc123`");
    expect(body).toContain("the prod environment");
    expect(body).toMatch(/approval gate|Sync|apply/i);
  });
});

// A dry run has to work where the PR path cannot: no remote, no `gh`, and the
// repository left exactly as it was found. That is what makes chant#1208's
// round-trip demonstrable offline instead of only asserting the noop case.
describe("rollbackToRevision --dry-run", () => {
  const git = async (args: string[], cwd: string) => {
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    return promisify(execFile)("git", args, { cwd });
  };

  /** A throwaway repo with two commits and NO remote configured. */
  async function repoWithTwoCommits(): Promise<{ dir: string; base: string }> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "chant-rollback-test-"));
    mkdirSync(join(dir, "src"));
    await git(["init", "-q"], dir);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "src", "main.ts"), "export const a = 1;\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "v1"], dir);
    const base = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    writeFileSync(join(dir, "src", "main.ts"), "export const a = 2;\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "v2"], dir);
    return { dir, base };
  }

  test("returns the delta without a remote, and leaves no branch behind", async () => {
    const { dir, base } = await repoWithTwoCommits();
    const before = (await git(["branch", "--format=%(refname:short)"], dir)).stdout.trim();

    const result = await rollbackToRevision({ ref: base, env: "local", sourceDir: "src", cwd: dir, dryRun: true });

    expect(result.noop).toBe(false);
    expect(result.prUrl).toBeUndefined();
    expect(result.diff).toContain("-export const a = 2;");
    expect(result.diff).toContain("+export const a = 1;");

    // Nothing persisted: same branches as before, and the working tree still
    // holds the NEW content — a dry run reports, it does not roll back.
    const after = (await git(["branch", "--format=%(refname:short)"], dir)).stdout.trim();
    expect(after).toBe(before);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toContain("a = 2");
  });

  test("still reports noop when the source already matches the ref", async () => {
    const { dir } = await repoWithTwoCommits();
    const result = await rollbackToRevision({ ref: "HEAD", env: "local", sourceDir: "src", cwd: dir, dryRun: true });
    expect(result.noop).toBe(true);
    expect(result.diff).toBeUndefined();
  });
});
