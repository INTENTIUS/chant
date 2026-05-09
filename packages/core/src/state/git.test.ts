import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeSnapshot,
  readSnapshot,
  readEnvironmentSnapshots,
  listSnapshots,
  getHeadCommit,
} from "./git";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  // Need at least one commit so HEAD exists.
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("state/git", () => {
  test("writeSnapshot creates the orphan branch and writes JSON addressable by readSnapshot", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const json = JSON.stringify({ resources: { bucket: { type: "T", status: "OK" } } });
      const sha = await writeSnapshot("prod", "aws", json, { cwd: dir });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(out).not.toBeNull();
      expect(JSON.parse(out!)).toEqual(JSON.parse(json));
    });
  });

  test("readSnapshot returns null for missing env/lexicon", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(out).toBeNull();
    });
  });

  test("subsequent writes preserve other env+lexicon entries", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
      await writeSnapshot("prod", "gcp", JSON.stringify({ b: 2 }), { cwd: dir });
      await writeSnapshot("staging", "aws", JSON.stringify({ c: 3 }), { cwd: dir });

      expect(await readSnapshot("prod", "aws", { cwd: dir })).toBeTruthy();
      expect(await readSnapshot("prod", "gcp", { cwd: dir })).toBeTruthy();
      expect(await readSnapshot("staging", "aws", { cwd: dir })).toBeTruthy();
    });
  });

  test("re-writing the same env+lexicon updates the entry rather than duplicating", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 1 }), { cwd: dir });
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 2 }), { cwd: dir });
      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(JSON.parse(out!)).toEqual({ v: 2 });
    });
  });

  test("readEnvironmentSnapshots returns all lexicons for an env", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
      await writeSnapshot("prod", "gcp", JSON.stringify({ b: 2 }), { cwd: dir });
      const all = await readEnvironmentSnapshots("prod", { cwd: dir });
      expect([...all.keys()].sort()).toEqual(["aws", "gcp"]);
    });
  });

  test("listSnapshots returns commit history of the orphan branch", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 1 }), { cwd: dir });
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 2 }), { cwd: dir });
      const log = await listSnapshots({ cwd: dir });
      expect(log.length).toBe(2);
      expect(log[0].commit).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  test("getHeadCommit returns the working-branch HEAD sha", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const head = await getHeadCommit({ cwd: dir });
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});
