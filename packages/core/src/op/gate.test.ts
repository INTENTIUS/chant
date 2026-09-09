/**
 * The gate against a real `chant/lifecycle` branch, in the two checkout
 * shapes CI actually produces (#2301, #2303).
 *
 * Everything else that exercises `evaluateGate` does it through
 * `memoryGateLedgerPort`, which is the right tool for the decision rules and
 * the wrong one for these two bugs: both are properties of the git port —
 * what a commit needs in order to be written at all, and what a checkout can
 * see of a branch it never fetched. Both were found by the first real
 * execution of a generated Op pipeline (INTENTIUS/choudoufu#1026); neither is
 * reachable without a repository on disk.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateGate, gitGateLedgerPort } from "./gate";
import { appendGateResolution, readGateLedger } from "../lifecycle/gate-ledger";
import { requireLifecycleLedgerWritable, LifecycleLedgerUnreadableError } from "../lifecycle/git";

function git(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1 };
}

const dirs: string[] = [];
function tmp(tag: string): string {
  const p = join(tmpdir(), `chant-gate-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  dirs.push(p);
  return p;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * A bare remote plus one clone that has already pushed `main`. The pair is
 * what makes the #2303 cases expressible at all: the bug is a difference
 * between what a remote holds and what a checkout can see of it.
 */
async function clonePair(): Promise<{ remote: string; author: string }> {
  const remote = tmp("remote");
  const author = tmp("author");
  await mkdir(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main"], remote);
  git(["clone", "-q", remote, author], tmpdir());
  git(["config", "user.email", "test@chant.dev"], author);
  git(["config", "user.name", "Test"], author);
  writeFileSync(join(author, "README.md"), "fixture\n");
  git(["add", "README.md"], author);
  git(["commit", "-q", "-m", "init"], author);
  git(["push", "-q", "origin", "main"], author);
  return { remote, author };
}

/**
 * A checkout in the state a GitLab CI job is in: `main` and nothing else.
 * `--single-branch` is the closest local equivalent of GitLab's refspec
 * fetch — it leaves the clone with no `chant/lifecycle`, not even a
 * remote-tracking one, which is the whole of finding 1. (`GIT_DEPTH: 0` does
 * not change this on GitLab either: it fetches refspecs, not all branches.)
 */
function ciCheckout(remote: string): string {
  const dir = tmp("ci");
  git(["clone", "-q", "--single-branch", "--branch", "main", remote, dir], tmpdir());
  git(["config", "user.email", "ci@chant.dev"], dir);
  git(["config", "user.name", "CI"], dir);
  return dir;
}

function lifecycleCommitCount(dir: string, ref = "chant/lifecycle"): number {
  const r = git(["rev-list", "--count", ref], dir);
  return r.exitCode === 0 ? Number(r.stdout.trim()) : 0;
}

describe("op/gate — a CI checkout with no git identity (#2301)", () => {
  /**
   * Deliverable 1. Strips the checkout of any identity the way a CI clone
   * arrives: no `user.name`, no `user.email`, and `user.useConfigOnly` so
   * git refuses to invent one from `$USER@$HOSTNAME` rather than succeeding
   * on some machines and failing on others.
   */
  function stripIdentity(dir: string): void {
    git(["config", "--unset-all", "user.email"], dir);
    git(["config", "--unset-all", "user.name"], dir);
    git(["config", "user.useConfigOnly", "true"], dir);
  }

  /** Blank out the global/system config so the developer's own identity cannot leak in. */
  async function withoutAmbientIdentity(fn: () => Promise<void>): Promise<void> {
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      await fn();
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = saved.s;
    }
  }

  test("records the pending fact anyway, under chant's own committer", async () => {
    const { author } = await clonePair();
    await withoutAmbientIdentity(async () => {
      stripIdentity(author);

      // The bare `git commit-tree` this goes through exits 128 with "no email
      // was given" in this checkout; before #2301 that is where the gate died.
      const check = await evaluateGate(gitGateLedgerPort({ cwd: author }), {
        op: "live-apply",
        gate: "approve-live-apply",
        now: "2026-09-09T05:00:00.000Z",
      });

      expect(check.satisfied).toBe(false);
      if (check.satisfied) return;
      expect(check.recorded).toBe(true);

      const { pending } = await readGateLedger("live-apply", { cwd: author });
      expect(pending.map((p) => p.gate)).toEqual(["approve-live-apply"]);

      // The fallback is chant's, applied per-invocation — nothing was written
      // into the checkout's own config.
      const committer = git(["log", "-1", "--format=%cn <%ce>", "chant/lifecycle"], author);
      expect(committer.stdout.trim()).toBe("chant <chant@localhost>");
      expect(git(["config", "--get", "user.email"], author).exitCode).not.toBe(0);
    });
  });

  test("a configured identity still authors the ledger commit", async () => {
    const { author } = await clonePair();
    await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    const committer = git(["log", "-1", "--format=%cn <%ce>", "chant/lifecycle"], author);
    expect(committer.stdout.trim()).toBe("Test <test@chant.dev>");
  });

  test("the committer fallback is overridable per project", async () => {
    const { author } = await clonePair();
    const saved = process.env.CHANT_LIFECYCLE_COMMITTER_EMAIL;
    process.env.CHANT_LIFECYCLE_COMMITTER_NAME = "estate-bot";
    process.env.CHANT_LIFECYCLE_COMMITTER_EMAIL = "estate-bot@example.com";
    try {
      await withoutAmbientIdentity(async () => {
        stripIdentity(author);
        await evaluateGate(gitGateLedgerPort({ cwd: author }), {
          op: "live-apply",
          gate: "approve-live-apply",
          now: "2026-09-09T05:00:00.000Z",
        });
        const committer = git(["log", "-1", "--format=%cn <%ce>", "chant/lifecycle"], author);
        expect(committer.stdout.trim()).toBe("estate-bot <estate-bot@example.com>");
      });
    } finally {
      delete process.env.CHANT_LIFECYCLE_COMMITTER_NAME;
      if (saved === undefined) delete process.env.CHANT_LIFECYCLE_COMMITTER_EMAIL;
      else process.env.CHANT_LIFECYCLE_COMMITTER_EMAIL = saved;
    }
  });

  /**
   * The identity fallback removes the one cause #2301 was reported for; it
   * does not make the write infallible, and the issue is explicit that the
   * message matters more than the cause. Whatever else goes wrong in there
   * has to say that what failed was chant writing a named file on its own
   * branch — `git hash-object failed: ...` on its own does not.
   */
  test("a ledger write that cannot happen names the branch and the path", async () => {
    const notARepo = tmp("not-a-repo");
    await mkdir(notARepo, { recursive: true });
    await expect(
      evaluateGate(gitGateLedgerPort({ cwd: notARepo }), {
        op: "live-apply",
        gate: "approve-live-apply",
        now: "2026-09-09T05:00:00.000Z",
      }),
    ).rejects.toThrow(/cannot write _gates\/live-apply\.jsonl on the chant\/lifecycle branch/);
  });
});

describe("op/gate — a CI checkout that never fetched the ledger (#2303)", () => {
  test("finding 1: approve then re-run closes the gate, without a second pending fact", async () => {
    const { remote, author } = await clonePair();

    // Run 1, in a checkout that has the branch: gates and records the fact.
    const first = await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    expect(first.satisfied).toBe(false);
    git(["push", "-q", "origin", "chant/lifecycle:chant/lifecycle"], author);

    // The operator approves.
    await appendGateResolution(
      {
        op: "live-apply",
        gate: "approve-live-apply",
        resolvedBy: "e2e-operator",
        timestamp: "2026-09-09T05:15:45.515Z",
      },
      { cwd: author },
    );
    git(["push", "-q", "origin", "chant/lifecycle:chant/lifecycle"], author);

    // Run 2 is the retried CI job: same commit, a checkout with no
    // `chant/lifecycle` at all. Before #2303 it read an empty ledger, saw no
    // resolution and no standing fact, and recorded a *second* pending one.
    const ci = ciCheckout(remote);
    expect(git(["rev-parse", "--verify", "refs/heads/chant/lifecycle"], ci).exitCode).not.toBe(0);

    const second = await evaluateGate(gitGateLedgerPort({ cwd: ci }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:20:00.000Z",
    });

    expect(second.satisfied).toBe(true);
    if (!second.satisfied) return;
    expect(second.resolution.resolvedBy).toBe("e2e-operator");

    const { pending } = await readGateLedger("live-apply", { cwd: ci });
    expect(pending).toHaveLength(1);
  });

  test("finding 1: an unreachable ledger is refused by name, not read as empty", async () => {
    const { remote, author } = await clonePair();
    await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    git(["push", "-q", "origin", "chant/lifecycle:chant/lifecycle"], author);

    const ci = ciCheckout(remote);
    // The remote goes away mid-flight — a lost network, a revoked token, a
    // runner that cannot reach the forge. The ledger's contents are now
    // unknown, which is precisely what must not be reported as "nothing has
    // been approved".
    await rm(remote, { recursive: true, force: true });

    await expect(
      evaluateGate(gitGateLedgerPort({ cwd: ci }), {
        op: "live-apply",
        gate: "approve-live-apply",
        now: "2026-09-09T05:20:00.000Z",
      }),
    ).rejects.toThrow(/chant\/lifecycle ledger branch is not in this checkout and could not be fetched/);
  });

  test("finding 1: a project whose ledger was never written still gates normally", async () => {
    // The other half of the refusal: "absent from the remote" is a real
    // empty ledger, and a first gate must not be refused.
    const { author } = await clonePair();
    const check = await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.recorded).toBe(true);
  });

  test("finding 2: approving from an unfetched clone appends, and the pending fact survives", async () => {
    const { remote, author } = await clonePair();

    await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    git(["push", "-q", "origin", "chant/lifecycle:chant/lifecycle"], author);
    const before = lifecycleCommitCount(author);
    expect(before).toBe(1);

    // The obvious operator move: clone, approve, push. This clone has never
    // seen `chant/lifecycle`, so before #2303 the append built its tree from
    // an empty read and committed with no parent — the branch went from one
    // commit holding the pending record to one commit holding only the
    // resolution.
    const approver = ciCheckout(remote);
    await requireLifecycleLedgerWritable({ cwd: approver });
    await appendGateResolution(
      {
        op: "live-apply",
        gate: "approve-live-apply",
        resolvedBy: "e2e-operator",
        timestamp: "2026-09-09T05:15:45.515Z",
      },
      { cwd: approver },
    );

    const { pending, resolutions } = await readGateLedger("live-apply", { cwd: approver });
    expect(pending).toHaveLength(1);
    expect(resolutions.map((r) => r.resolvedBy)).toEqual(["e2e-operator"]);
    // Appended to the history, not written over it.
    expect(lifecycleCommitCount(approver)).toBe(before + 1);
  });

  test("finding 2: a local ledger that diverged from the remote refuses rather than appending across the fork", async () => {
    const { remote, author } = await clonePair();
    await evaluateGate(gitGateLedgerPort({ cwd: author }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    git(["push", "-q", "origin", "chant/lifecycle:chant/lifecycle"], author);

    // A second operator builds their own unrelated root commit on the same
    // branch name — exactly what the pre-#2303 unfetched-approve produced.
    const other = ciCheckout(remote);
    await appendGateResolution(
      { op: "other-op", gate: "g", resolvedBy: "someone", timestamp: "2026-09-09T05:10:00.000Z" },
      { cwd: other },
    );
    expect(lifecycleCommitCount(other)).toBe(1);

    await expect(requireLifecycleLedgerWritable({ cwd: other })).rejects.toBeInstanceOf(
      LifecycleLedgerUnreadableError,
    );
    await expect(requireLifecycleLedgerWritable({ cwd: other })).rejects.toThrow(
      /has diverged from the copy on "origin"/,
    );
  });

  test("a project with no remote is local-only and is never refused", async () => {
    const dir = tmp("solo");
    await mkdir(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@chant.dev"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "init"], dir);

    const check = await evaluateGate(gitGateLedgerPort({ cwd: dir }), {
      op: "live-apply",
      gate: "approve-live-apply",
      now: "2026-09-09T05:00:00.000Z",
    });
    expect(check.satisfied).toBe(false);
    await expect(requireLifecycleLedgerWritable({ cwd: dir })).resolves.toBeUndefined();
  });
});
