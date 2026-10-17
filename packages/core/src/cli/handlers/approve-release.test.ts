/**
 * `chant approve` on a release gate (#4045): the approval copies the release
 * the pending fact names, with its plan and environment, so it counts for
 * that release only. Against a temp repo; nothing is pushed.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { makeRelease, persistRelease } from "../../lifecycle/release-store";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { recordGateApproval } = await import("./approve");

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** The release the gate binds. #4033: approve reads it to check its commit isn't revoked, so it is stored. */
const STORED = makeRelease({ member: null, commit: "1".repeat(40), artifactDigests: [], targets: [{ env: "prod", templates: [], params: [] }] });
const RELEASE = STORED.releaseDigest;
const DOC = `jcs1-sha256:${"d".repeat(64)}`;

async function repoWithReleaseGate(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@chant.dev"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  await persistRelease(STORED, [], { cwd: dir });
  await appendPendingGate(
    {
      op: "release",
      gate: "prod-release",
      timestamp: "2026-10-16T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      planDigest: DOC,
      environment: "prod",
      releaseDigest: RELEASE,
    },
    { cwd: dir },
  );
}

describe("chant approve on a release gate (#4045)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("the approval names the release, the environment and the change set the pending fact names", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      await repoWithReleaseGate(dir);
      process.chdir(dir);
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
      expect(outcome.ok).toBe(true);
      const { resolutions } = await readGateLedger("release", { cwd: dir });
      expect(resolutions).toEqual([expect.objectContaining({ resolvedBy: "alice", planDigest: DOC, environment: "prod", releaseDigest: RELEASE })]);
    });
  });

  test("an approval of another plan names no release, so no release gate counts it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      await repoWithReleaseGate(dir);
      process.chdir(dir);
      const other = `jcs1-sha256:${"e".repeat(64)}`;
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod", plan: other });
      expect(outcome.ok).toBe(true);
      const { resolutions } = await readGateLedger("release", { cwd: dir });
      expect(resolutions[0].planDigest).toBe(other);
      expect(resolutions[0].releaseDigest).toBeUndefined();
    });
  });
});
