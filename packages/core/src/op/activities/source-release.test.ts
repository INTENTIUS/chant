/**
 * chant #2782 — the source-release activities: a tree of HEAD archived to the
 * same bytes every time, a release plan named by its own digest, and a release
 * recorded in the ledger once.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSourceArchive } from "../source-archive";
import { sourceArchive, releasePlan, releaseRecord, readReleasePlan, releasePlanDigest } from "./source-release";
import { readReleaseLedger } from "../../lifecycle/release-ledger";
import { readReleasePlan as readPersistedPlan } from "../../lifecycle/plan-ledger";
import { appendGateResolution } from "../../lifecycle/gate-ledger";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, "app/migrations"), { recursive: true });
  mkdirSync(join(dir, "delivery"), { recursive: true });
  writeFileSync(join(dir, "app/server.js"), "console.log('hi');\n");
  writeFileSync(join(dir, "app/run.sh"), "#!/bin/sh\nnode server.js\n");
  chmodSync(join(dir, "app/run.sh"), 0o755);
  writeFileSync(join(dir, "app/migrations/0001_init.sql"), "CREATE TABLE t (id INTEGER);\n");
  writeFileSync(join(dir, "delivery/README.md"), "delivery\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("sourceArchive", () => {
  test("archives a directory of HEAD to the same bytes each time, and reads back only at its digest", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const cwd = join(dir, "delivery");
      writeFileSync(join(dir, "app/uncommitted.js"), "not shipped\n");
      const a = await sourceArchive({ path: "../app", cwd });
      const b = await sourceArchive({ path: "../app", cwd, out: "dist/again.tar" });
      expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(b.digest).toBe(a.digest);
      expect(a.commit).toBe(git(["rev-parse", "HEAD"], dir));
      expect(a.dir).toBe("app");
      expect(a.files).toBe(3);
      expect(a.archive).toBe(join(cwd, "dist/releases", `${a.commit}.tar`));

      const files = readSourceArchive({ archive: a.archive, digest: a.digest, dir: a.dir });
      expect(files.map((f) => f.path).sort()).toEqual(["migrations/0001_init.sql", "run.sh", "server.js"]);
      expect(files.find((f) => f.path === "run.sh")!.executable).toBe(true);
      expect(files.find((f) => f.path === "server.js")!.executable).toBe(false);
      expect(files.find((f) => f.path === "server.js")!.data.toString()).toBe("console.log('hi');\n");

      // Any other bytes are refused, naming both digests.
      writeFileSync(a.archive, Buffer.concat([readFileSync(a.archive), Buffer.from("x")]));
      expect(() => readSourceArchive({ archive: a.archive, digest: a.digest, dir: a.dir })).toThrow(/not the approved sha256:/);
    });
  });

  test("a directory not in the commit is refused", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      await expect(sourceArchive({ path: "../nope", cwd: join(dir, "delivery") })).rejects.toThrow(/not in commit/);
    });
  });
});

describe("releasePlan", () => {
  test("is named by its own canonical content, so the same release plans the same digest", async () => {
    await withTestDir(async (dir) => {
      const one = await releasePlan({ component: "app", env: "fly", gitSha: "abc", content: { artifact: { digest: "sha256:1" }, shipSkip: false }, cwd: dir });
      const two = await releasePlan({ component: "app", env: "fly", gitSha: "abc", content: { shipSkip: false, artifact: { digest: "sha256:1" } }, cwd: dir });
      expect(two.digest).toBe(one.digest);
      const other = await releasePlan({ component: "app", env: "fly", gitSha: "abd", content: { artifact: { digest: "sha256:1" }, shipSkip: false }, cwd: dir });
      expect(other.digest).not.toBe(one.digest);
      const plan = readReleasePlan(one.file, one.digest);
      expect(plan).toMatchObject({ digest: one.digest, component: "app", env: "fly", gitSha: "abc", shipSkip: false });
      expect(releasePlanDigest(plan)).toBe(one.digest);
      expect(() => readReleasePlan(one.file, other.digest)).toThrow(/not the approved/);
    });
  });
});

describe("releaseRecord", () => {
  test("persists the plan, records the release with the gate's approver, and records a retry once", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const gitSha = git(["rev-parse", "HEAD"], dir);
      const plan = await releasePlan({ component: "app", env: "fly", gitSha, content: { artifact: { digest: "sha256:1" } }, cwd: dir });
      await appendGateResolution(
        { op: "release", gate: "ship", resolvedBy: "alice", timestamp: "2026-09-25T00:00:00Z", planDigest: plan.digest },
        { cwd: dir },
      );
      const first = await releaseRecord({ plan: plan.file, digest: plan.digest, approval: { op: "release", gate: "ship" }, actor: "bob", cwd: dir });
      expect(first).toEqual({ recorded: true, digest: plan.digest, env: "fly", component: "app", approver: "alice" });
      const again = await releaseRecord({ plan: plan.file, digest: plan.digest, approval: { op: "release", gate: "ship" }, actor: "bob", cwd: dir });
      expect(again.recorded).toBe(false);

      const { records } = await readReleaseLedger("fly", { cwd: dir });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ component: "app", env: "fly", digest: plan.digest, gitSha, actor: "bob", approver: "alice" });
      expect(await readPersistedPlan(plan.digest, { cwd: dir })).toMatchObject({ digest: plan.digest, component: "app" });
    });
  });

  test("refuses a plan that is not the approved digest", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const plan = await releasePlan({ component: "app", env: "fly", gitSha: "abc", content: {}, cwd: dir });
      await expect(releaseRecord({ plan: plan.file, digest: "sha256:other", actor: "bob", cwd: dir })).rejects.toThrow(/not the approved/);
    });
  });
});
