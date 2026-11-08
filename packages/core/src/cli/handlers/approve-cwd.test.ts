/**
 * #4760: `recordGateApproval(op, gate, { cwd })` reads, appends and pushes the
 * ledger of the repository at `cwd`, never the one the process runs in.
 *
 * Both repositories are temp repos with temp bare remotes, and the process is
 * moved into the bystander for the call, so a regression writes into and
 * pushes a throwaway repository rather than the checkout running the tests.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { recordGateApproval } = await import("./approve");

function git(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: r.status, out: (r.stdout ?? "").trim() };
}

function ok(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const PLAN = `jcs1-sha256:${"a".repeat(64)}`;

/** A repo at `<root>/<name>` with one commit on main, pushed to a bare remote at `<root>/<name>.git`. */
function repoWithRemote(root: string, name: string): { dir: string; remote: string } {
  const dir = join(root, name);
  const remote = join(root, `${name}.git`);
  mkdirSync(dir);
  ok(root, "init", "-q", "--bare", "-b", "main", remote);
  ok(dir, "init", "-q", "-b", "main");
  ok(dir, "config", "user.email", "t@chant.dev");
  ok(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "README"), `${name}\n`);
  ok(dir, "add", ".");
  ok(dir, "commit", "-q", "-m", "init");
  ok(dir, "remote", "add", "origin", remote);
  ok(dir, "push", "-q", "origin", "main");
  return { dir, remote };
}

function hasLifecycleBranch(gitDir: string): boolean {
  return git(gitDir, "rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle").status === 0;
}

describe("recordGateApproval with a cwd other than the process's (#4760)", () => {
  const home = process.cwd();
  afterEach(() => {
    process.chdir(home);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  async function inTwoRepos(fn: (target: { dir: string; remote: string }, bystander: { dir: string; remote: string }) => Promise<void>) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (root) => {
      const target = repoWithRemote(root, "target");
      const bystander = repoWithRemote(root, "bystander");
      process.chdir(bystander.dir);
      try {
        await fn(target, bystander);
      } finally {
        process.chdir(home);
      }
    });
  }

  function expectUntouched(bystander: { dir: string; remote: string }) {
    expect(hasLifecycleBranch(bystander.dir)).toBe(false);
    expect(hasLifecycleBranch(bystander.remote)).toBe(false);
  }

  test("answers the pending fact in the cwd's ledger and pushes there, leaving the process's repo alone", async () => {
    await inTwoRepos(async (target, bystander) => {
      await appendPendingGate(
        { op: "deploy", gate: "prod", timestamp: "2026-11-07T10:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: PLAN },
        { cwd: target.dir },
      );
      ok(target.dir, "push", "-q", "origin", "chant/lifecycle");

      const outcome = await recordGateApproval("deploy", "prod", { origin: "cli", actor: "alice", cwd: target.dir });

      expect(outcome).toMatchObject({ ok: true, pushed: true });
      expect((await readGateLedger("deploy", { cwd: target.dir })).resolutions).toEqual([
        expect.objectContaining({ gate: "prod", resolvedBy: "alice", planDigest: PLAN }),
      ]);
      expect(ok(target.remote, "rev-parse", "refs/heads/chant/lifecycle")).toBe(ok(target.dir, "rev-parse", "refs/heads/chant/lifecycle"));
      expectUntouched(bystander);
    });
  });

  test("with --plan and nothing pending anywhere, the record and the push still go to the cwd", async () => {
    await inTwoRepos(async (target, bystander) => {
      const outcome = await recordGateApproval("deploy", "prod", { origin: "cli", actor: "alice", plan: PLAN, cwd: target.dir });

      expect(outcome).toMatchObject({ ok: true, pushed: true });
      expect((await readGateLedger("deploy", { cwd: target.dir })).resolutions).toHaveLength(1);
      expect(hasLifecycleBranch(target.remote)).toBe(true);
      expectUntouched(bystander);
    });
  });
});
