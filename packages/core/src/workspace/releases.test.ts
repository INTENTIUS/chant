/**
 * The `releases` read (#4026, ws-104): releases with their targets, cuts and
 * the environments that run them, held to `releases.schema.json`.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { contract } from "./__fixtures__/contract-repo";
import releasesSchema from "./releases.schema.json";
import { releasesDocument, RELEASES_SCHEMA_ID } from "./releases";
import { appendCut, makeRelease, persistRelease } from "../lifecycle/release-store";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { writeLedgerFiles } from "../lifecycle/git";

const { expectValid } = contract(releasesSchema);

function initRepo(dir: string): void {
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"]]) spawnSync("git", args, { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

const release = (commit: string) =>
  makeRelease({
    member: null,
    commit,
    artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: `sha256:${"a".repeat(64)}` }],
    targets: [
      { env: "staging", templates: [{ component: "api", path: "t.json", digest: `sha256:${"b".repeat(64)}` }], params: [{ name: "tier", value: "small", source: "default" }] },
      { env: "prod", templates: [{ component: "api", path: "t.json", digest: `sha256:${"c".repeat(64)}` }], params: [{ name: "tier", value: "large", source: "default" }] },
    ],
  });

const deploy = (env: string, component: string, releaseDigest?: string, timestamp = "2026-10-16T12:00:00.000Z") =>
  appendReleaseRecord({ component, env, digest: `sha256:${"a".repeat(64)}`, gitSha: "1".repeat(40), runId: "r", timestamp, actor: "ci", ...(releaseDigest ? { releaseDigest } : {}) }, { cwd: dirOf.current });
const dirOf = { current: "" };

describe("releasesDocument", () => {
  test("lists each release with its targets, cuts and the environments whose latest deploy names it", async () => {
    await withTestDir(async (dir) => {
      dirOf.current = dir;
      initRepo(dir);
      const r1 = release("1".repeat(40));
      const r2 = release("2".repeat(40));
      await persistRelease(r1, [], { cwd: dir });
      await persistRelease(r2, [], { cwd: dir });
      await appendCut({ releaseDigest: r1.releaseDigest, label: "v1", actor: "alice", timestamp: "2026-10-16T10:00:00.000Z", runOrigin: null }, { cwd: dir });
      await appendCut({ releaseDigest: r2.releaseDigest, label: "v2", actor: "bob", timestamp: "2026-10-16T11:00:00.000Z", runOrigin: { forge: "github", repo: "o/r" } }, { cwd: dir });
      await deploy("staging", "api", r2.releaseDigest);
      await deploy("prod", "api", r1.releaseDigest);
      await deploy("staging", "web");

      const doc = await releasesDocument({ cwd: dir });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc).toMatchObject({ $schema: RELEASES_SCHEMA_ID, contract: 1, member: null, reason: null });
      expect(doc.releases.map((r) => [r.label, r.environments])).toEqual([
        ["v2", [{ env: "staging", components: ["api"] }]],
        ["v1", [{ env: "prod", components: ["api"] }]],
      ]);
      expect(doc.releases[0]).toMatchObject({
        releaseDigest: r2.releaseDigest,
        commit: "2".repeat(40),
        artifactDigests: r2.artifactDigests,
        targets: r2.targets,
        cuts: [{ label: "v2", actor: "bob", timestamp: "2026-10-16T11:00:00.000Z", runOrigin: { forge: "github", repo: "o/r" }, signature: null }],
      });
    });
  });

  test("a release file that is not a release and a cut line that is not a cut are left out under ledger-malformed", async () => {
    await withTestDir(async (dir) => {
      dirOf.current = dir;
      initRepo(dir);
      const r = release("3".repeat(40));
      await persistRelease(r, [], { cwd: dir });
      await writeLedgerFiles(
        [
          { path: `_releases/jcs1-sha256_${"9".repeat(64)}.json`, content: "{not json" },
          { path: "_releases/cuts.jsonl", content: `{"version":1}\n` },
        ],
        "broken",
        { cwd: dir },
      );
      const doc = await releasesDocument({ cwd: dir });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.releases.map((x) => x.releaseDigest)).toEqual([r.releaseDigest]);
      expect(doc.reason).toEqual({ code: "ledger-malformed", message: "1 release file(s) and 1 cut line(s) could not be read and are left out" });
    });
  });

  test("an empty ledger lists no releases, and outside git the read fails with not-a-git-repository", async () => {
    await withTestDir(async (dir) => {
      const outside = await releasesDocument({ cwd: dir });
      expectValid(outside);
      expect(outside).toMatchObject({ error: { code: "not-a-git-repository" } });
      initRepo(dir);
      const empty = await releasesDocument({ cwd: dir });
      expectValid(empty);
      expect(empty).toMatchObject({ releases: [], reason: null });
    });
  });
});
