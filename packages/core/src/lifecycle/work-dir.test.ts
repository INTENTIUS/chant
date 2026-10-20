/**
 * #2893: work worktrees live at `.chant/work/[<member>/]<item>` in the
 * checkout, excluded through `<git-common-dir>/info/exclude`, and the
 * hand-written walkers skip them.
 */
import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { excludeWorkDir, isWorkDir, removeEmptyWorkDirs, workWorktreePath, legacyWorkWorktreePath, WORK_DIR_EXCLUDE } from "./work-dir";
import { listFiles } from "../workspace/export";

describe("the work directory", () => {
  test("a worktree is .chant/work/[<member>/]<item> in the checkout; older versions made it under the git directory", () => {
    expect(workWorktreePath("/repo", [], "W-1")).toBe(join("/repo", ".chant", "work", "W-1"));
    expect(workWorktreePath("/repo", ["app"], "W-1")).toBe(join("/repo", ".chant", "work", "app", "W-1"));
    expect(legacyWorkWorktreePath("/repo/.git", ["app"], "W-1")).toBe(join("/repo/.git", "chant-work", "app", "W-1"));
  });

  test("isWorkDir is .chant/work at the walk's root or below it, and nothing else in .chant", () => {
    expect(isWorkDir(".chant/work")).toBe(true);
    expect(isWorkDir("members/app/.chant/work")).toBe(true);
    expect(isWorkDir(".chant")).toBe(false);
    expect(isWorkDir(".chant/factory")).toBe(false);
    expect(isWorkDir("x.chant/work")).toBe(false);
  });

  test("the exclude line is written once, after any last line without a newline, and not when git already ignores the directory", async () => {
    await withTestDir(async (dir) => {
      const common = join(dir, "git");
      expect(excludeWorkDir(common, false)).toBe(true);
      expect(readFileSync(join(common, "info", "exclude"), "utf-8")).toBe(`${WORK_DIR_EXCLUDE}\n`);
      expect(excludeWorkDir(common, false)).toBe(false);
      expect(readFileSync(join(common, "info", "exclude"), "utf-8")).toBe(`${WORK_DIR_EXCLUDE}\n`);

      const other = join(dir, "other");
      mkdirSync(join(other, "info"), { recursive: true });
      writeFileSync(join(other, "info", "exclude"), "*.log");
      expect(excludeWorkDir(other, false)).toBe(true);
      expect(readFileSync(join(other, "info", "exclude"), "utf-8")).toBe(`*.log\n${WORK_DIR_EXCLUDE}\n`);

      const ignored = join(dir, "ignored");
      expect(excludeWorkDir(ignored, true)).toBe(false);
      expect(existsSync(join(ignored, "info", "exclude"))).toBe(false);
    });
  });

  test("removing a worktree takes the empty directories above it up to .chant, and stops at one that holds anything", async () => {
    await withTestDir(async (dir) => {
      // The worktree itself is gone already: removed, its parent left empty.
      const tree = workWorktreePath(dir, ["app"], "W-1");
      mkdirSync(dirname(tree), { recursive: true });
      mkdirSync(workWorktreePath(dir, [], "W-2"), { recursive: true });
      removeEmptyWorkDirs(tree);
      expect(existsSync(dirname(tree))).toBe(false);
      expect(existsSync(join(dir, ".chant", "work", "W-2"))).toBe(true);

      const only = join(dir, "only");
      mkdirSync(join(only, ".chant", "work"), { recursive: true });
      removeEmptyWorkDirs(workWorktreePath(only, [], "W-3"));
      expect(existsSync(join(only, ".chant"))).toBe(false);
      expect(existsSync(only)).toBe(true);
    });
  });
});

describe("walkers skip .chant/work", () => {
  test("export's file list outside git leaves out a work worktree and keeps the rest of .chant", async () => {
    await withTestDir(async (dir) => {
      for (const p of ["a.ts", ".chant/workspace.lock.json", ".chant/work/W-1/a.ts", "m/.chant/work/W-2/a.ts"]) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), "x");
      }
      expect(listFiles(dir)).toEqual([".chant/workspace.lock.json", "a.ts"]);
    });
  });
});
