/**
 * #4033 (ws-105): a release cut from a revoked commit, read at read time from
 * the `ci/revoked/<sha>` tag. `workspace status` flags an environment that
 * runs it, with the rollback line, and reads its pending gate as superseded;
 * `release list` marks it. Against temp repos; nothing is pushed.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import statusSchema from "./status.schema.json";
import releasesSchema from "./releases.schema.json";
import { formatStatus, workspaceStatus, type StatusDocument } from "./status";
import { releasesDocument } from "./releases";
import { contract } from "./__fixtures__/contract-repo";
import { appendCut, makeRelease, persistRelease, type Release } from "../lifecycle/release-store";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { appendPendingGate } from "../lifecycle/gate-ledger";
import type { CommandContext } from "../cli/registry";
import { contentDigest } from "../content-digest";

const validateStatus = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
const { expectValid: expectValidReleases } = contract(releasesSchema);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const DOC = `jcs1-sha256:${"d".repeat(64)}`;
const NOW = "2026-10-16T14:00:00.000Z";

/** A workspace whose root member runs release v1.0.0 in prod and waits at its staging gate, and a second release v1.1.0 from a later commit. */
async function setup(dir: string): Promise<{ old: string; release: Release; next: Release }> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(
    join(dir, "chant.workspace.json"),
    JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the fixture" }], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"] } } }, null, 2),
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const old = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--allow-empty", "-m", "next");
  const later = git(dir, "rev-parse", "HEAD");
  const at = (commit: string) =>
    makeRelease({ member: null, commit, artifactDigests: [], targets: ["staging", "prod"].map((env) => ({ env, templates: [{ component: "api", path: "t.json", digest: `sha256:${"c".repeat(64)}` }], params: [] })) });
  const release = at(old);
  const next = at(later);
  for (const [r, label, ts] of [[release, "v1.0.0", "10"], [next, "v1.1.0", "11"]] as const) {
    await persistRelease(r, [], { cwd: dir });
    await appendCut({ releaseDigest: r.releaseDigest, label, actor: "alice", timestamp: `2026-10-16T${ts}:00:00.000Z`, runOrigin: null }, { cwd: dir });
  }
  const deploy = { component: "api", digest: contentDigest("api image"), runId: "r", actor: "ci" };
  await appendReleaseRecord({ ...deploy, env: "prod", gitSha: old, timestamp: "2026-10-16T12:00:00.000Z", releaseDigest: release.releaseDigest }, { cwd: dir });
  await appendReleaseRecord({ ...deploy, env: "staging", gitSha: later, timestamp: "2026-10-16T12:00:00.000Z", releaseDigest: next.releaseDigest }, { cwd: dir });
  for (const [r, env] of [[release, "staging"], [next, "prod"]] as const) {
    await appendPendingGate(
      { op: "release", gate: `${env}-release`, timestamp: "2026-10-16T13:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: DOC, environment: env, releaseDigest: r.releaseDigest },
      { cwd: dir },
    );
  }
  return { old, release, next };
}

function revoke(dir: string, sha: string): void {
  const record = { schema: 1, tag: "revoked", commit: sha, branch: "main", at: "2026-10-16T12:30:00.000Z", phase: "test", run: { name: "test", id: 77, conclusion: "failure", url: "https://example.test/runs/77" } };
  git(dir, "tag", "-a", "-m", `ci: phase test failed in test (failure)\n\n${JSON.stringify(record, null, 2)}\n`, `ci/revoked/${sha}`, sha);
}

function result(doc: StatusDocument): Extract<StatusDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(validateStatus(doc), JSON.stringify(validateStatus.errors, null, 2)).toBe(true);
  return doc;
}

describe("a revoked release in workspace status and release list (#4033)", () => {
  test("an environment running a release cut from a revoked commit is flagged with the rollback line, and the release's pending gate is superseded", async () => {
    await withTestDir(async (dir) => {
      const { old, release, next } = await setup(dir);

      // Before the revocation nothing is flagged.
      const before = result(await workspaceStatus({ cwd: dir, env: "prod", compareTo: "staging", now: NOW }));
      expect(before.members[0].environments[0].releases[0]).not.toHaveProperty("revoked");
      expect(before.members[0].gates.map((g) => [g.name, g.state])).toEqual([["prod-release", "pending"], ["staging-release", "pending"]]);

      revoke(dir, old);
      const doc = result(await workspaceStatus({ cwd: dir, env: "prod", compareTo: "staging", now: NOW }));
      const [prod, staging] = doc.members[0].environments;
      expect(prod.releases[0].revoked).toEqual({
        commit: old,
        tag: `ci/revoked/${old}`,
        tagged: expect.any(String),
        phase: "test",
        run: { name: "test", id: 77, conclusion: "failure", url: "https://example.test/runs/77" },
        signer: null,
        releaseDigest: release.releaseDigest,
        label: "v1.0.0",
        rollback: "chant components rollback prod --component api",
      });
      // staging runs the later release, which is not revoked.
      expect(staging.releases[0]).not.toHaveProperty("revoked");

      const [prodGate, stagingGate] = doc.members[0].gates;
      expect(prodGate).toMatchObject({ name: "prod-release", releaseDigest: next.releaseDigest, state: "pending" });
      expect(prodGate).not.toHaveProperty("revoked");
      expect(stagingGate).toMatchObject({ name: "staging-release", releaseDigest: release.releaseDigest, state: "superseded", revoked: { commit: old, tag: `ci/revoked/${old}`, phase: "test" } });

      expect(formatStatus(doc)).toContain(
        `  prod: api runs release v1.0.0, revoked by ci/revoked/${old} (phase test failed in test (run 77)); roll back: chant components rollback prod --component api`,
      );
    });
  });

  test("release list marks the revoked release, in JSON and in text", async () => {
    await withTestDir(async (dir) => {
      const { old } = await setup(dir);
      revoke(dir, old);
      const doc = await releasesDocument({ cwd: dir });
      expectValidReleases(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.releases.map((r) => [r.label, r.revoked?.tag ?? null])).toEqual([
        ["v1.1.0", null],
        ["v1.0.0", `ci/revoked/${old}`],
      ]);

      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...m: unknown[]) => { out.push(m.join(" ")); });
      vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { err.push(m.join(" ")); });
      const cwd = process.cwd();
      try {
        process.chdir(dir);
        const { runReleaseList } = await import("../cli/handlers/release");
        expect(await runReleaseList({ args: {} } as unknown as CommandContext)).toBe(0);
      } finally {
        process.chdir(cwd);
      }
      expect(out.find((l) => l.startsWith("v1.0.0"))).toMatch(/ {2}revoked$/);
      expect(out.find((l) => l.startsWith("v1.1.0"))).not.toMatch(/revoked/);
      expect(err).toContain(`  v1.0.0: revoked by ci/revoked/${old}, phase test failed in test (run 77)`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
