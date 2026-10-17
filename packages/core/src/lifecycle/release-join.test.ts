/**
 * The join through the release digest (#4043), against a temp repo: two
 * releases of one commit, and deploys of one release in two environments.
 * The end-to-end chain, with a real cut, promote and approval, is in
 * cli/handlers/release-join.e2e.test.ts.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinRelease } from "./release-join";
import { appendCut, makeRelease, persistRelease } from "./release-store";
import { appendReleaseRecord } from "./release-ledger";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const subject = (commit: string, digest: string) => ({
  member: null,
  commit,
  artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest }],
  targets: [{ env: "dev", templates: [], params: [] }],
});

describe("joinRelease", () => {
  test("a commit joins to every release cut from it, each with its own deploys across environments", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@chant.dev");
      git(dir, "config", "user.name", "T");
      writeFileSync(join(dir, "README.md"), "x\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");
      const sha = git(dir, "rev-parse", "HEAD");
      const one = makeRelease(subject(sha, "sha256:1"));
      const two = makeRelease(subject(sha, "sha256:2"));
      for (const [r, label] of [[one, "v1"], [two, null]] as const) {
        await persistRelease(r, [], { cwd: dir });
        await appendCut({ releaseDigest: r.releaseDigest, label, actor: "alice", timestamp: "2026-10-16T10:00:00.000Z", runOrigin: null, signature: null }, { cwd: dir });
      }
      const rec = (env: string, runId: string, timestamp: string, releaseDigest?: string) =>
        appendReleaseRecord({ component: "api", env, digest: "sha256:1", gitSha: sha, runId, timestamp, actor: "ci", ...(releaseDigest ? { releaseDigest } : {}) }, { cwd: dir });
      await rec("prod", "r3", "2026-10-16T13:00:00.000Z", one.releaseDigest);
      await rec("dev", "r1", "2026-10-16T11:00:00.000Z", one.releaseDigest);
      await rec("dev", "r2", "2026-10-16T12:00:00.000Z"); // a deploy of the commit that named no release
      await rec("dev", "r4", "2026-10-16T14:00:00.000Z", two.releaseDigest);

      const { releases } = await joinRelease({ commit: sha }, { cwd: dir });
      expect(releases.map((r) => [r.label, r.deploys.map((d) => `${d.env}:${d.runId}`)])).toEqual(
        expect.arrayContaining([["v1", ["dev:r1", "prod:r3"]], [null, ["dev:r4"]]]),
      );
      expect(releases).toHaveLength(2);
      expect(releases.every((r) => r.commit === sha)).toBe(true);
      expect(releases.find((r) => r.label === "v1")!.gates).toEqual({ pending: [], resolutions: [] });

      // The unlabelled release is reached by its digest, and the record that named no release joins nowhere.
      expect((await joinRelease({ release: two.releaseDigest }, { cwd: dir })).releases[0].deploys.map((d) => d.runId)).toEqual(["r4"]);
      expect((await joinRelease({ deploy: { releaseDigest: undefined } }, { cwd: dir })).releases).toEqual([]);
      expect((await joinRelease({ release: "nope" }, { cwd: dir })).reason).toMatch(/no release is labelled or digested "nope"/);
      const ghost = `jcs1-sha256:${"9".repeat(64)}`;
      expect((await joinRelease({ gate: { releaseDigest: ghost } }, { cwd: dir })).reason).toMatch(/file is not on this checkout/);
    });
  });
});
