/**
 * #4033 (ws-105): when a commit is revoked, the release cut from it is
 * revoked, and its pending release gate refuses approval. Against temp repos;
 * nothing is pushed.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { appendCut, makeRelease, persistRelease, type Release } from "../../lifecycle/release-store";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { recordGateApproval } = await import("./approve");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const DOC = `jcs1-sha256:${"d".repeat(64)}`;
const GREEN = { branch: "main", phases: { test: ["test"] }, require: ["test"] };

function declaration(dir: string, green: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "chant.workspace.json"),
    JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the release fixture" }], ci: { green } }, null, 2),
  );
}

/** A green commit, a release cut from it as v1.0.0, and a release gate pending for it in prod. */
async function releaseWaitingAtGate(dir: string): Promise<{ sha: string; release: Release }> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  declaration(dir, GREEN);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "-a", "-m", "ci: green", `ci/green/${sha}`, sha);
  const release = makeRelease({
    member: null,
    commit: sha,
    artifactDigests: [],
    targets: [{ env: "prod", templates: [{ component: "api", path: "t.json", digest: `sha256:${"c".repeat(64)}` }], params: [] }],
  });
  await persistRelease(release, [], { cwd: dir });
  await appendCut({ releaseDigest: release.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: "2026-10-16T10:00:00.000Z", runOrigin: null }, { cwd: dir });
  await appendPendingGate(
    {
      op: "release",
      gate: "prod-release",
      timestamp: "2026-10-16T11:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      planDigest: DOC,
      environment: "prod",
      releaseDigest: release.releaseDigest,
      gitSha: sha,
    },
    { cwd: dir },
  );
  return { sha, release };
}

/** ci tick's revoked tag for a run from chant runs (#4044): the run's id is null and the Op run is named in opRun. */
function revoke(dir: string, sha: string): void {
  const record = {
    schema: 1,
    tag: "revoked",
    commit: sha,
    branch: "main",
    at: "2026-10-16T12:00:00.000Z",
    source: "runs",
    phase: "test",
    run: { name: "smoke", id: null, conclusion: "failure", url: null, opRun: { id: "r-12", env: "staging", signer: "runner:ci", statement: null } },
  };
  git(dir, "tag", "-a", "-m", `ci: phase test failed in smoke (failure)\n\n${JSON.stringify(record, null, 2)}\n`, `ci/revoked/${sha}`, sha);
}

describe("chant approve on the gate of a revoked release (#4033)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("revoke a commit, and its release's pending gate refuses approval with release-revoked and the fix line", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.join(" ")); });
    await withTestDir(async (dir) => {
      const { sha } = await releaseWaitingAtGate(dir);
      process.chdir(dir);
      revoke(dir, sha);
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
      expect(outcome.ok).toBe(false);
      const said = errors.join("\n");
      expect(said).toContain(`release v1.0.0 was cut from commit ${sha.slice(0, 12)}, which ci/revoked/${sha} revokes (phase test failed in smoke (Op run r-12 in staging))`);
      expect(said).toContain("[release-revoked]");
      expect(said).toContain("chant approve release prod-release --expire");
      expect((await readGateLedger("release", { cwd: dir })).resolutions).toEqual([]);

      // Naming the plan outright doesn't get round it.
      const named = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod", plan: DOC });
      expect(named.ok).toBe(false);
      expect((await readGateLedger("release", { cwd: dir })).resolutions).toEqual([]);
    });
  });

  test("before the commit is revoked, the same gate takes the approval", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      const { release } = await releaseWaitingAtGate(dir);
      process.chdir(dir);
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
      expect(outcome.ok).toBe(true);
      expect((await readGateLedger("release", { cwd: dir })).resolutions).toEqual([expect.objectContaining({ releaseDigest: release.releaseDigest })]);
    });
  });

  test("with ci.green.signedSince, a hand-pushed revoked tag is ignored and revokes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      const { sha } = await releaseWaitingAtGate(dir);
      // The release's own commit is the pivot, so a tag on it needs a statement; this one has none.
      declaration(dir, { ...GREEN, signedSince: sha });
      git(dir, "commit", "-q", "-am", "require signed ci tags");
      revoke(dir, sha);
      process.chdir(dir);
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
      expect(outcome.ok).toBe(true);
    });
  });

  test("a gate whose release can't be read refuses, since whether it is revoked is unknown", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.join(" ")); });
    await withTestDir(async (dir) => {
      await releaseWaitingAtGate(dir);
      await appendPendingGate(
        { op: "release", gate: "prod-release", timestamp: "2026-10-16T13:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: DOC, environment: "prod", releaseDigest: `jcs1-sha256:${"e".repeat(64)}` },
        { cwd: dir },
      );
      process.chdir(dir);
      const outcome = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
      expect(outcome.ok).toBe(false);
      expect(errors.join("\n")).toContain("[release-unreadable]");
    });
  });
});
