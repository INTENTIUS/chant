/**
 * chant #2800 — the rollback activities for a source release: the release
 * before the latest one picked from the ledger, its tree archived again and
 * checked against the digest its plan recorded, and the rollback recorded
 * once with the release it restores.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceArchive, releasePlan, releaseRecord } from "./source-release";
import { pickRollback, releaseRollbackPlan, releaseRollbackRecord } from "./source-rollback";
import { readReleaseLedger, type ReleaseRecord } from "../../lifecycle/release-ledger";
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
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "delivery"), { recursive: true });
  writeFileSync(join(dir, "delivery/README.md"), "delivery\n");
}

/** Commit the app as `body`, then plan and record its release as the release Op does. */
async function release(dir: string, body: string, recordedDigest?: string): Promise<{ digest: string; archive: string; gitSha: string }> {
  writeFileSync(join(dir, "app/server.js"), body);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", body], dir);
  const cwd = join(dir, "delivery");
  const archive = await sourceArchive({ path: "../app", cwd });
  const plan = await releasePlan({ component: "app", env: "fly", gitSha: archive.commit, content: { artifact: { kind: "source-tree", digest: recordedDigest ?? archive.digest, dir: archive.dir } }, cwd });
  await releaseRecord({ plan: plan.file, digest: plan.digest, actor: "releaser", cwd });
  return { digest: plan.digest, archive: archive.digest, gitSha: archive.commit };
}

const rec = (digest: string, timestamp: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  version: 1,
  component: "app",
  env: "fly",
  digest,
  gitSha: digest.slice(-4),
  runId: `run-${timestamp}`,
  timestamp,
  actor: "a",
  ...extra,
});

describe("pickRollback", () => {
  test("goes back to what the site served before the latest release, and a rollback's own record does not move it", () => {
    const a = rec("sha256:a", "1");
    const b = rec("sha256:b", "2");
    expect(pickRollback([a, b], "app", "fly")).toEqual({ target: a, replaced: b });
    // After the rollback, the same rollback is planned again.
    const back = rec("sha256:a", "3", { restores: { env: "fly", runId: a.runId, timestamp: a.timestamp } });
    expect(pickRollback([a, b, back], "app", "fly")).toEqual({ target: a, replaced: b });
    // A release after the rollback goes back to what the rollback served.
    const c = rec("sha256:c", "4");
    expect(pickRollback([a, b, back, c], "app", "fly")).toMatchObject({ target: { digest: "sha256:a", timestamp: "3" }, replaced: c });
    // A redeploy of the same digest is not an earlier release.
    expect(pickRollback([a, b, rec("sha256:b", "5")], "app", "fly")).toMatchObject({ target: a });
  });

  test("names what is missing", () => {
    expect(pickRollback([], "app", "fly")).toEqual({ error: 'no release of "app" is recorded in "fly"' });
    expect(pickRollback([rec("sha256:a", "1")], "app", "fly")).toMatchObject({ error: expect.stringMatching(/no release in "fly" before sha256:a/) });
    expect(pickRollback([rec("sha256:a", "1"), rec("sha256:b", "2")], "app", "fly", "sha256:z")).toMatchObject({ error: expect.stringMatching(/has digest sha256:z/) });
    expect(pickRollback([rec("sha256:a", "1"), rec("sha256:b", "2")], "app", "fly", "sha256:a")).toMatchObject({ target: { digest: "sha256:a" } });
  });
});

describe("releaseRollbackPlan and releaseRollbackRecord", () => {
  test("plan the previous release with its tree archived again, record it once with the approver, and plan the same rollback after", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const cwd = join(dir, "delivery");
      const a = await release(dir, "console.log('a');\n");
      const b = await release(dir, "console.log('b');\n");

      const plan = await releaseRollbackPlan({ component: "app", env: "fly", cwd });
      expect(plan).toMatchObject({ to: a.digest, from: b.digest, gitSha: a.gitSha, archiveDigest: a.archive, dir: "app" });
      expect(plan.archive).toBe(join(cwd, "dist/releases", `${a.gitSha}.tar`));

      await appendGateResolution({ op: "rollback", gate: "rollback", resolvedBy: "alice", timestamp: "2026-09-25T00:00:03Z", planDigest: plan.digest }, { cwd });
      const first = await releaseRollbackRecord({ plan: plan.file, digest: plan.digest, approval: { op: "rollback", gate: "rollback" }, actor: "bob", cwd });
      expect(first).toEqual({ recorded: true, digest: a.digest, env: "fly", component: "app", approver: "alice" });

      const { records } = await readReleaseLedger("fly", { cwd });
      expect(records).toHaveLength(3);
      expect(records[2]).toMatchObject({ component: "app", digest: a.digest, gitSha: a.gitSha, actor: "bob", approver: "alice", restores: { env: "fly", runId: records[0].runId, timestamp: records[0].timestamp } });

      // Again: the same plan digest, so the approval holds, and nothing more is recorded.
      const again = await releaseRollbackPlan({ component: "app", env: "fly", cwd });
      expect(again.digest).toBe(plan.digest);
      expect((await releaseRollbackRecord({ plan: again.file, digest: again.digest, actor: "bob", cwd })).recorded).toBe(false);
      expect((await readReleaseLedger("fly", { cwd })).records).toHaveLength(3);
    });
  });

  test("a release whose tree does not archive to the digest its plan recorded is refused", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const cwd = join(dir, "delivery");
      await release(dir, "console.log('a');\n", "sha256:0000");
      await release(dir, "console.log('b');\n");
      await expect(releaseRollbackPlan({ component: "app", env: "fly", cwd })).rejects.toThrow(/archives to sha256:[0-9a-f]{64}, not the sha256:0000 release sha256:[0-9a-f]{64} recorded/);
    });
  });

  test("a release with no recorded plan is refused by name", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      writeFileSync(join(dir, "app/server.js"), "x\n");
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "x"], dir);
      const cwd = join(dir, "delivery");
      const { appendReleaseRecord } = await import("../../lifecycle/release-ledger");
      for (const [d, t] of [["sha256:aa", "2026-09-25T00:00:01Z"], ["sha256:bb", "2026-09-25T00:00:02Z"]]) {
        await appendReleaseRecord({ component: "app", env: "fly", digest: d, gitSha: "abc", runId: t, timestamp: t, actor: "a" }, { cwd });
      }
      await expect(releaseRollbackPlan({ component: "app", env: "fly", cwd })).rejects.toThrow(/no plan is recorded for sha256:aa/);
    });
  });
});
