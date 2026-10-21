/**
 * `release cut --at` (#4168 4.2): the commit is checked out in a temporary
 * worktree with the checkout's node_modules linked in, and removed after.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutCommit, CutAtError, resolveCutCommit } from "./release-at";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

describe("checkoutCommit", () => {
  test("checks the commit out detached, links node_modules at the top and the member, and removes it", async () => {
    await withTestDir(async (dir) => {
      for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"]]) git(dir, ...args);
      mkdirSync(join(dir, "members", "api"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      writeFileSync(join(dir, "members", "api", "f.txt"), "old");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "one");
      const one = git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "members", "api", "f.txt"), "new");
      git(dir, "commit", "-q", "-am", "two");
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, "members", "api", "node_modules"));

      expect(resolveCutCommit(dir, "HEAD~1")).toBe(one);
      expect(() => resolveCutCommit(dir, "nope")).toThrow(CutAtError);

      const co = checkoutCommit(dir, join(dir, "members", "api"), one);
      expect(readFileSync(join(co.memberDir, "f.txt"), "utf-8")).toBe("old");
      expect(lstatSync(join(co.dir, "node_modules")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(co.memberDir, "node_modules")).isSymbolicLink()).toBe(true);
      expect(git(co.dir, "rev-parse", "HEAD")).toBe(one);
      co.remove();
      co.remove();
      expect(existsSync(co.dir)).toBe(false);
      expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
    });
  });
});
