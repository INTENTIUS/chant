/**
 * #4637: two clones of one bare origin write to `chant/lifecycle`. An approval
 * pushed from one clone survives every write the other makes afterwards.
 *
 * A plain `git fetch` in a full clone moves `refs/remotes/origin/chant/lifecycle`
 * and leaves the local branch where it was. A write then built on the local
 * branch, pushed with a lease on that ref, used to pass the lease and replace
 * the remote's history with a branch missing the approval.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushLifecycleRebasing, pushLifecycleStatus, writeBlobToPath } from "./git";
import { appendGateResolution } from "./gate-ledger";
import { appendRunRecord } from "./run-ledger";
import type { OpRunRecordInput } from "../op/runtime";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

function tmp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ledger-two-${name}-`)));
  dirs.push(dir);
  return dir;
}

function clone(origin: string, name: string): string {
  const dir = tmp(name);
  git(["clone", "-q", origin, dir], tmpdir());
  git(["config", "user.email", `${name}@chant.dev`], dir);
  git(["config", "user.name", name], dir);
  return dir;
}

/** A bare origin with `main` and a seeded `chant/lifecycle`, and two clones that both hold the seed locally. */
async function setup(): Promise<{ origin: string; a: string; b: string }> {
  const origin = tmp("origin");
  git(["init", "-q", "--bare", "-b", "main"], origin);
  const a = clone(origin, "a");
  writeFileSync(join(a, "README.md"), "fixture\n");
  git(["add", "README.md"], a);
  git(["commit", "-q", "-m", "init"], a);
  git(["push", "-q", "origin", "main"], a);
  await writeBlobToPath("prod", "seed.jsonl", '{"seed":true}\n', "seed", { cwd: a });
  expect((await pushLifecycleStatus({ cwd: a })).status).toBe("pushed");
  const b = clone(origin, "b");
  git(["fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle"], b);
  return { origin, a, b };
}

const approval = { op: "deploy", gate: "prod", resolvedBy: "github:alice", timestamp: "2026-11-07T10:00:00Z" };

function run(overrides: Partial<OpRunRecordInput> = {}): OpRunRecordInput {
  return {
    op: "deploy",
    env: "prod",
    started: "2026-11-07T10:01:00.000Z",
    ended: "2026-11-07T10:02:00.000Z",
    status: "ok",
    labels: {},
    outcomes: {},
    phases: [],
    ...overrides,
  };
}

/** A file on origin's `chant/lifecycle`, or "" when it has none. */
function onOrigin(origin: string, path: string): string {
  try {
    return execFileSync("git", ["--git-dir", origin, "show", `chant/lifecycle:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function approveInA(a: string): Promise<void> {
  await appendGateResolution(approval, { cwd: a });
  expect((await pushLifecycleStatus({ cwd: a })).status).toBe("pushed");
}

describe("ledger writers in two clones of one origin (#4637)", () => {
  test("a write after a plain fetch keeps the approval the other clone pushed", async () => {
    const { origin, a, b } = await setup();
    await approveInA(a);

    // An ordinary fetch: the tracking ref moves, the local branch does not.
    git(["fetch", "-q", "origin"], b);
    await appendRunRecord(run(), { cwd: b });
    await pushLifecycleRebasing({ cwd: b });

    expect(onOrigin(origin, "_gates/deploy.jsonl")).toContain("github:alice");
    expect(onOrigin(origin, "prod/runs__deploy.jsonl")).toContain('"status":"ok"');
  });

  test("a write committed before the fetch is replayed onto the approval, never pushed over it", async () => {
    const { origin, a, b } = await setup();
    await approveInA(a);

    await appendRunRecord(run(), { cwd: b });
    // The fetch lands after the commit, so the local branch no longer contains the lease.
    git(["fetch", "-q", "origin"], b);
    const status = await pushLifecycleStatus({ cwd: b });
    expect(status.status).toBe("stale");
    expect(onOrigin(origin, "_gates/deploy.jsonl")).toContain("github:alice");

    expect(await pushLifecycleRebasing({ cwd: b })).toEqual({ pushed: true });
    expect(onOrigin(origin, "_gates/deploy.jsonl")).toContain("github:alice");
    expect(git(["--git-dir", origin, "log", "--format=%s", "chant/lifecycle"], b).split("\n")).toEqual(
      expect.arrayContaining(["Gate resolution record", "Op run record: deploy"]),
    );
  });

  test("a write with no fetch at all is refused as stale, then replayed onto the approval", async () => {
    const { origin, a, b } = await setup();
    await approveInA(a);

    await appendRunRecord(run(), { cwd: b });
    expect((await pushLifecycleStatus({ cwd: b })).status).toBe("stale");
    expect(await pushLifecycleRebasing({ cwd: b })).toEqual({ pushed: true });
    expect(onOrigin(origin, "_gates/deploy.jsonl")).toContain("github:alice");
  });
});

