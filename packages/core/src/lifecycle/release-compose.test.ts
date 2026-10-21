/**
 * `release compose` (#4168 4.3): chosen trunk commits cherry-picked onto a
 * base, each with a `Chant-Composed-From` trailer, on a pushed
 * `chant/compose/<name>` branch, appended to and never rewritten.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeRelease, ComposeError } from "./release-compose";
import { composeBranchContaining, composedFrom, composedIncluding, compositionOf } from "./compose-refs";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A clone of a bare remote with trunk: base, then #1 (a.txt), #2 (b.txt, work w-2), #3 (a.txt again). */
function trunk(dir: string): { clone: string; remote: string; base: string; c1: string; c2: string; c3: string } {
  const remote = join(dir, "remote.git");
  const clone = join(dir, "clone");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(clone);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"], ["remote", "add", "origin", remote]]) git(clone, ...args);
  const commit = (file: string, text: string, message: string): string => {
    writeFileSync(join(clone, file), text);
    git(clone, "add", file);
    git(clone, "commit", "-q", "-m", message);
    return git(clone, "rev-parse", "HEAD");
  };
  const base = commit("a.txt", "a0\n", "base");
  const c1 = commit("a.txt", "a1\n", "fix a (#1)");
  const c2 = commit("b.txt", "b\n", "add b (#2)\n\nChant-Record: work:w-2");
  const c3 = commit("a.txt", "a3\n", "rework a (#3)");
  git(clone, "push", "-q", "origin", "main");
  git(clone, "fetch", "-q", "origin");
  return { clone, remote, base, c1, c2, c3 };
}

const TRUNK = { remote: "origin", branch: "main" };

describe("composeRelease", () => {
  test("picks the chosen changes in trunk order onto the base, with trailers, and pushes the branch", async () => {
    await withTestDir(async (dir) => {
      const t = trunk(dir);
      const dry = await composeRelease({ cwd: t.clone, name: "hotfix", base: t.base, prs: [], works: ["w-2"], yes: false, trunk: TRUNK });
      expect(dry.written).toBe(false);
      expect(dry.picked.map((s) => s.commit)).toEqual([t.c2]);
      expect(git(t.clone, "branch", "--list", "chant/compose/hotfix")).toBe("");

      const r = await composeRelease({ cwd: t.clone, name: "hotfix", base: t.base, prs: [2, 1], works: [], yes: true, trunk: TRUNK });
      expect(r.picked.map((s) => s.commit)).toEqual([t.c1, t.c2]);
      expect(r.picked[1].work).toEqual(["w-2"]);
      expect(r.written).toBe(true);
      expect(r.pushed).toBe(true);
      expect(git(t.remote, "rev-parse", "refs/heads/chant/compose/hotfix")).toBe(r.tip);
      expect(composedFrom(t.clone, r.tip)).toEqual([t.c2]);
      expect(compositionOf(t.clone, r.tip)).toEqual({ branch: null, base: t.base, sources: [t.c1, t.c2] });
      expect(composeBranchContaining(t.clone, r.tip)?.branch).toBe("chant/compose/hotfix");
      expect(composedIncluding(t.clone, t.c1)).toEqual([{ branch: "chant/compose/hotfix", commit: git(t.clone, "rev-parse", `${r.tip}^`) }]);
      expect(git(t.clone, "show", `${r.tip}:a.txt`)).toBe("a1");
    });
  });

  test("appends to the branch, skips what it carries, and refuses another base", async () => {
    await withTestDir(async (dir) => {
      const t = trunk(dir);
      const first = await composeRelease({ cwd: t.clone, name: "x", base: t.base, prs: [1], works: [], yes: true, trunk: TRUNK });
      const again = await composeRelease({ cwd: t.clone, name: "x", prs: [1, 2], works: [], yes: true, trunk: TRUNK });
      expect(again.from).toBe(first.tip);
      expect(again.already.map((s) => s.commit)).toEqual([t.c1]);
      expect(again.picked.map((s) => s.commit)).toEqual([t.c2]);
      expect(git(t.clone, "rev-parse", `${again.tip}^`)).toBe(first.tip);
      await expect(composeRelease({ cwd: t.clone, name: "x", base: t.c1, prs: [3], works: [], yes: true, trunk: TRUNK })).rejects.toMatchObject({ code: "compose-base-differs" });
    });
  });

  test("stops on a conflict, names the change and the file, and writes nothing", async () => {
    await withTestDir(async (dir) => {
      const t = trunk(dir);
      const err = await composeRelease({ cwd: t.clone, name: "y", base: t.base, prs: [3], works: [], yes: true, trunk: TRUNK }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ComposeError);
      expect((err as ComposeError).code).toBe("compose-conflict");
      expect((err as ComposeError).conflict).toMatchObject({ commit: t.c3, files: ["a.txt"] });
      expect((err as ComposeError).message).toContain("#3");
      expect(git(t.clone, "branch", "--list", "chant/compose/y")).toBe("");
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/compose/y"], { cwd: t.remote }).status).not.toBe(0);
      expect(git(t.clone, "worktree", "list").split("\n")).toHaveLength(1);
    });
  });

  test("refuses a change trunk does not have, a bad name, and no base for a new branch", async () => {
    await withTestDir(async (dir) => {
      const t = trunk(dir);
      await expect(composeRelease({ cwd: t.clone, name: "z", base: t.base, prs: [9], works: [], yes: false, trunk: TRUNK })).rejects.toMatchObject({ code: "compose-source-unknown" });
      await expect(composeRelease({ cwd: t.clone, name: "../z", base: t.base, prs: [1], works: [], yes: false, trunk: TRUNK })).rejects.toMatchObject({ code: "compose-name-invalid" });
      await expect(composeRelease({ cwd: t.clone, name: "z", prs: [1], works: [], yes: false, trunk: TRUNK })).rejects.toMatchObject({ code: "compose-base-unknown" });
      await expect(composeRelease({ cwd: t.clone, name: "z", base: t.base, prs: [], works: [], yes: false, trunk: TRUNK })).rejects.toMatchObject({ code: "compose-nothing-chosen" });
    });
  });
});

describe("composeRelease after a hand-made commit", () => {
  test("keeps the branch's base when its tip carries no trailer", async () => {
    await withTestDir(async (dir) => {
      const t = trunk(dir);
      const first = await composeRelease({ cwd: t.clone, name: "h", base: t.base, prs: [1], works: [], yes: true, trunk: TRUNK });
      // A person resolves something on the branch and pushes it.
      git(t.clone, "checkout", "-q", "chant/compose/h");
      writeFileSync(join(t.clone, "c.txt"), "by hand\n");
      git(t.clone, "add", "c.txt");
      git(t.clone, "commit", "-q", "-m", "by hand");
      git(t.clone, "push", "-q", "origin", "chant/compose/h");
      git(t.clone, "checkout", "-q", "main");
      const next = await composeRelease({ cwd: t.clone, name: "h", base: t.base, prs: [1, 2], works: [], yes: true, trunk: TRUNK });
      expect(next.base).toBe(t.base);
      expect(next.already.map((s) => s.commit)).toEqual([t.c1]);
      expect(next.picked.map((s) => s.commit)).toEqual([t.c2]);
      expect(git(t.clone, "rev-parse", `${next.tip}~2`)).toBe(first.tip);
    });
  });
});
