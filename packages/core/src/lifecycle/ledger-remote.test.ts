import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseLedgerRemote, LIFECYCLE_REMOTE_ENV, lifecycleRemoteOverride } from "./ledger-remote";
import {
  fetchLifecycleStatus,
  fetchRef,
  pushLifecycleRebasing,
  pushLifecycleReport,
  pushLifecycleStatus,
  pushRef,
  readRefSha,
  updateRefCAS,
  writeBlob,
  writeBlobToPath,
} from "./git";
import { NO_RECORD_ENV } from "./no-record";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function tip(repo: string, ref = "refs/heads/chant/lifecycle"): string | null {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Two checkouts, A and B, cloned from a bare `origin` that is not where the
 * ledger belongs, each with a second remote `ledger` that is.
 */
function setup(): { a: string; b: string; origin: string; ledger: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "chant-ledger-remote-"));
  const origin = join(root, "origin.git");
  const ledger = join(root, "ledger.git");
  git(["init", "-q", "--bare", "-b", "main", origin], root);
  git(["init", "-q", "--bare", "-b", "main", ledger], root);
  const seed = join(root, "seed");
  git(["clone", "-q", origin, seed], root);
  git(["config", "user.email", "seed@chant.dev"], seed);
  git(["config", "user.name", "Seed"], seed);
  writeFileSync(join(seed, "README.md"), "fixture\n");
  git(["add", "README.md"], seed);
  git(["commit", "-q", "-m", "init"], seed);
  git(["push", "-q", "origin", "main"], seed);
  const clone = (name: string): string => {
    const dir = join(root, name);
    git(["clone", "-q", origin, dir], root);
    git(["config", "user.email", `${name}@chant.dev`], dir);
    git(["config", "user.name", name], dir);
    git(["remote", "add", "ledger", ledger], dir);
    return dir;
  };
  return { a: clone("a"), b: clone("b"), origin, ledger, root };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chooseLedgerRemote", () => {
  test("origin, else the first remote, when nothing is named", () => {
    expect(chooseLedgerRemote(["backup", "origin"], {})).toEqual({ remote: "origin" });
    expect(chooseLedgerRemote(["backup", "mirror"], {})).toEqual({ remote: "backup" });
    expect(chooseLedgerRemote([], {})).toBeNull();
  });

  test("the remote CHANT_LIFECYCLE_REMOTE names, over origin", () => {
    expect(chooseLedgerRemote(["origin", "ledger"], { [LIFECYCLE_REMOTE_ENV]: "ledger" })).toEqual({ remote: "ledger" });
    expect(chooseLedgerRemote(["origin", "ledger"], { [LIFECYCLE_REMOTE_ENV]: " ledger " })).toEqual({ remote: "ledger" });
  });

  test("a name the repository has no remote by fails, and never falls back to origin", () => {
    expect(chooseLedgerRemote(["origin"], { [LIFECYCLE_REMOTE_ENV]: "ledger" })).toEqual({
      failed: true,
      stderr: `${LIFECYCLE_REMOTE_ENV} names the remote "ledger", and this repository's remotes are origin`,
      named: "ledger",
    });
    expect(chooseLedgerRemote([], { [LIFECYCLE_REMOTE_ENV]: "ledger" })).toMatchObject({ failed: true });
  });

  test("empty counts as unset", () => {
    expect(lifecycleRemoteOverride({ [LIFECYCLE_REMOTE_ENV]: "  " })).toBeUndefined();
    expect(chooseLedgerRemote(["origin"], { [LIFECYCLE_REMOTE_ENV]: "" })).toEqual({ remote: "origin" });
  });
});

describe("CHANT_LIFECYCLE_REMOTE (#4647)", () => {
  test("the branch is pushed to and fetched from the named remote, with its remote-tracking ref, and origin is left alone", async () => {
    const { a, b, origin, ledger, root } = setup();
    try {
      vi.stubEnv(LIFECYCLE_REMOTE_ENV, "ledger");
      await writeBlobToPath("prod", "plan.json", '{"plan":1}', "plan", { cwd: a });
      expect(await pushLifecycleStatus({ cwd: a })).toMatchObject({ status: "pushed", remote: "ledger" });
      const pushed = tip(ledger);
      expect(pushed).toBe(tip(a));
      expect(tip(a, "refs/remotes/ledger/chant/lifecycle")).toBe(pushed);
      expect(tip(origin)).toBeNull();
      expect(tip(a, "refs/remotes/origin/chant/lifecycle")).toBeNull();

      expect(await fetchLifecycleStatus({ cwd: b })).toEqual({ status: "fetched" });
      expect(tip(b)).toBe(pushed);
      expect(tip(b, "refs/remotes/ledger/chant/lifecycle")).toBe(pushed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a push another writer beat to the named remote replays on its tip and lands there", async () => {
    const { a, b, origin, ledger, root } = setup();
    try {
      vi.stubEnv(LIFECYCLE_REMOTE_ENV, "ledger");
      await writeBlobToPath("prod", "seed.json", "{}", "seed", { cwd: a });
      expect((await pushLifecycleReport({ cwd: a })).pushed).toBe(true);
      expect((await fetchLifecycleStatus({ cwd: b })).status).toBe("fetched");

      // A moves the ledger on behind B's back.
      await writeBlobToPath("prod", "wave.json", '{"wave":1}', "wave", { cwd: a });
      expect((await pushLifecycleReport({ cwd: a })).pushed).toBe(true);
      await writeBlobToPath("prod", "merge.json", '{"merge":1}', "merge", { cwd: b });
      expect(await pushLifecycleStatus({ cwd: b })).toMatchObject({ status: "stale", remote: "ledger" });

      expect(await pushLifecycleRebasing({ cwd: b })).toEqual({ pushed: true });
      const landed = tip(ledger)!;
      expect(git(["show", `${landed}:prod/wave.json`], ledger)).toBe('{"wave":1}');
      expect(git(["show", `${landed}:prod/merge.json`], ledger)).toBe('{"merge":1}');
      expect(tip(b, "refs/remotes/ledger/chant/lifecycle")).toBe(landed);
      expect(tip(origin)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lease ref goes to the named remote too", async () => {
    const { a, b, origin, ledger, root } = setup();
    try {
      vi.stubEnv(LIFECYCLE_REMOTE_ENV, "ledger");
      const ref = "refs/chant/lease/converge";
      const blob = await writeBlob('{"holder":"a"}', { cwd: a });
      await updateRefCAS(ref, blob, null, { cwd: a });
      expect(await pushRef(ref, { cwd: a })).toBe(true);
      expect(tip(ledger, ref)).toBe(blob);
      expect(tip(origin, ref)).toBeNull();
      expect(await fetchRef(ref, { cwd: b })).toBe(true);
      expect(await readRefSha(ref, { cwd: b })).toBe(blob);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a name with no such remote fails the push, the fetch and a write, and sends nothing to origin", async () => {
    const { a, origin, root } = setup();
    try {
      await writeBlobToPath("prod", "plan.json", "{}", "plan", { cwd: a });
      vi.stubEnv(LIFECYCLE_REMOTE_ENV, "elsewhere");
      const pushed = await pushLifecycleStatus({ cwd: a });
      expect(pushed).toMatchObject({ status: "failed", remote: "elsewhere" });
      expect(pushed.status === "failed" ? pushed.stderr : "").toBe(`${LIFECYCLE_REMOTE_ENV} names the remote "elsewhere", and this repository's remotes are ledger, origin`);
      expect(await fetchLifecycleStatus({ cwd: a })).toMatchObject({ status: "unreachable", remote: "elsewhere" });
      expect(await pushRef("refs/heads/chant/lifecycle", { cwd: a })).toBe(false);
      expect(tip(origin)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run that records nothing pushes nothing to the named remote", async () => {
    const { a, ledger, root } = setup();
    try {
      vi.stubEnv(LIFECYCLE_REMOTE_ENV, "ledger");
      vi.stubEnv(NO_RECORD_ENV, "1");
      await writeBlobToPath("prod", "plan.json", "{}", "plan", { cwd: a });
      expect(await pushLifecycleStatus({ cwd: a })).toEqual({ status: "not-recorded" });
      expect(tip(ledger)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
