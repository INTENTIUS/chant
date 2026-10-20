/**
 * `ledger_sync`, the steward's reconciliation of its `chant/lifecycle` branch
 * with the repository's, run against real git: a bare repository, the
 * steward's long-lived clone and a second checkout that approves gates.
 *
 * The case it exists for: the steward keeps run records on its local branch
 * only (chant pushes facts, not runs), so an approval pushed from elsewhere
 * leaves the two branches diverged, and chant refuses to read a diverged
 * ledger.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SYNC_FN } from "./runtime";

const BRANCH = "refs/heads/chant/lifecycle";
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Append `line` to `path` on the clone's ledger branch, as chant's plumbing does: no checkout. */
function append(cwd: string, path: string, line: string): void {
  const parent = (() => {
    try {
      return git(cwd, "rev-parse", "--verify", "-q", BRANCH);
    } catch {
      return "";
    }
  })();
  const existing = parent ? (() => { try { return git(cwd, "show", `${parent}:${path}`) + "\n"; } catch { return ""; } })() : "";
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: `${existing}${line}\n`, encoding: "utf8" }).trim();
  const env = { ...process.env, GIT_INDEX_FILE: join(cwd, ".git", "test-index") };
  if (parent) execFileSync("git", ["read-tree", parent], { cwd, env });
  else execFileSync("git", ["read-tree", "--empty"], { cwd, env });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { cwd, env });
  const tree = execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8" }).trim();
  const commit = execFileSync("git", [...IDENTITY, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", line], { cwd, encoding: "utf8" }).trim();
  git(cwd, "update-ref", BRANCH, commit);
}

function sync(cwd: string): string {
  git(cwd, "fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*");
  return execFileSync("bash", ["-c", `${LEDGER_SYNC_FN}\nledger_sync`], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function remoteFile(path: string): string[] {
  return git(join(root, "remote.git"), "show", `chant/lifecycle:${path}`).split("\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "e2b-ledger-"));
  execFileSync("git", ["init", "--quiet", "--bare", "remote.git"], { cwd: root });
  for (const clone of ["steward", "laptop"]) {
    execFileSync("git", ["clone", "--quiet", join(root, "remote.git"), clone], { cwd: root, stdio: "pipe" });
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ledger_sync", () => {
  it("does nothing without a local ledger", () => {
    sync(join(root, "steward"));
    expect(() => git(join(root, "remote.git"), "rev-parse", "--verify", "chant/lifecycle")).toThrow();
  });

  it("pushes local-only run records when the steward is only ahead", () => {
    const steward = join(root, "steward");
    append(steward, "local/runs__deploy.jsonl", '{"id":"r1"}');
    sync(steward);
    expect(remoteFile("local/runs__deploy.jsonl")).toEqual(['{"id":"r1"}']);
  });

  it("merges a diverged ledger, keeping both sides' lines, and pushes it", () => {
    const steward = join(root, "steward");
    const laptop = join(root, "laptop");

    // The steward's gate: its pending fact is pushed, as chant pushes it.
    append(steward, "_gates/deploy.jsonl", '{"kind":"pending"}');
    git(steward, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);
    // Its run record stays local, as chant leaves it.
    append(steward, "local/runs__deploy.jsonl", '{"id":"r1","status":"gated"}');

    // An approval from another checkout.
    git(laptop, "fetch", "--quiet", "origin", `+${BRANCH}:${BRANCH}`);
    append(laptop, "_gates/deploy.jsonl", '{"kind":"resolution"}');
    git(laptop, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);

    const stderr = sync(steward);
    void stderr;

    expect(remoteFile("_gates/deploy.jsonl")).toEqual(['{"kind":"pending"}', '{"kind":"resolution"}']);
    expect(remoteFile("local/runs__deploy.jsonl")).toEqual(['{"id":"r1","status":"gated"}']);
    // Both tips are ancestors of the merge, so neither side diverges from it again.
    const tip = git(steward, "rev-parse", BRANCH);
    expect(git(join(root, "remote.git"), "rev-parse", "chant/lifecycle")).toBe(tip);
    git(laptop, "fetch", "--quiet", "origin", `${BRANCH}:${BRANCH}`);
    expect(git(laptop, "rev-parse", BRANCH)).toBe(tip);
  });

  it("unions an append-only file both sides wrote to", () => {
    const steward = join(root, "steward");
    const laptop = join(root, "laptop");
    append(steward, "local/runs__deploy.jsonl", '{"id":"r1"}');
    git(steward, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);
    append(steward, "local/runs__deploy.jsonl", '{"id":"r2"}');
    git(laptop, "fetch", "--quiet", "origin", `+${BRANCH}:${BRANCH}`);
    append(laptop, "local/runs__deploy.jsonl", '{"id":"l1"}');
    git(laptop, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);

    sync(steward);
    expect(remoteFile("local/runs__deploy.jsonl")).toEqual(['{"id":"r1"}', '{"id":"l1"}', '{"id":"r2"}']);
  });

  it("leaves a steward that is behind for chant's own fetch", () => {
    const steward = join(root, "steward");
    const laptop = join(root, "laptop");
    append(steward, "_gates/deploy.jsonl", '{"kind":"pending"}');
    git(steward, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);
    git(laptop, "fetch", "--quiet", "origin", `+${BRANCH}:${BRANCH}`);
    append(laptop, "_gates/deploy.jsonl", '{"kind":"resolution"}');
    git(laptop, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);

    const before = git(steward, "rev-parse", BRANCH);
    sync(steward);
    expect(git(steward, "rev-parse", BRANCH)).toBe(before);
  });
});
