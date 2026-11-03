/**
 * #4720: spending a gated request's approval in a checkout with no remote for
 * `chant/lifecycle`. The local branch is the whole ledger there, so the
 * applied line written to it spends the approval. A push that fails still
 * refuses, as before.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushLifecycleStatus, readBlobFromPath, writeBlobToPath } from "./git";
import { spendGatedRequest } from "./gated-request";
import { appliedGatePath, parseAppliedGateFile } from "./gate-applied";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `gated-spend-${name}-`)));
  dirs.push(dir);
  return dir;
}

function identity(dir: string): void {
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
}

function repo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  identity(dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

const spend = (cwd: string) => ({
  op: "tf-export",
  gate: "network",
  digest: "sha256:" + "a".repeat(64),
  approval: { resolvedBy: "github:bob", timestamp: "2026-11-02T10:00:00Z" },
  now: "2026-11-02T10:05:00Z",
  cwd,
});

async function appliedLines(cwd: string) {
  const { dir, file } = appliedGatePath("tf-export");
  const text = await readBlobFromPath(dir, file, { cwd });
  return text ? parseAppliedGateFile(text).applied : [];
}

describe("spendGatedRequest (#4720)", () => {
  test("with no remote, the applied line on the local branch spends the approval", async () => {
    const dir = tmp("local");
    repo(dir);
    expect(git(["remote"], dir)).toBe("");

    const record = await spendGatedRequest(spend(dir));
    expect(record).toMatchObject({ kind: "applied", gate: "network", approvedBy: "github:bob" });
    expect(await appliedLines(dir)).toEqual([expect.objectContaining({ gate: "network", planDigest: spend(dir).digest })]);
  });

  test("with a remote the push cannot reach, the spend still throws and nothing may apply", async () => {
    const remote = tmp("remote");
    git(["init", "-q", "--bare", "-b", "main"], remote);
    const dir = tmp("checkout");
    git(["clone", "-q", remote, dir], tmpdir());
    identity(dir);
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    git(["push", "-q", "origin", "main"], dir);
    await writeBlobToPath("prod", "releases.jsonl", '{"seed":true}\n', "seed", { cwd: dir });
    expect((await pushLifecycleStatus({ cwd: dir })).status).toBe("pushed");

    git(["remote", "set-url", "origin", join(remote, "gone")], dir);
    await expect(spendGatedRequest(spend(dir))).rejects.toThrow(/recorded as spent and not pushed .*failed.*so nothing may apply under it/);
  });

  test("with a remote another writer pushed to first, the spend still throws", async () => {
    const remote = tmp("remote");
    git(["init", "-q", "--bare", "-b", "main"], remote);
    const dir = tmp("checkout");
    git(["clone", "-q", remote, dir], tmpdir());
    identity(dir);
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    git(["push", "-q", "origin", "main"], dir);
    await writeBlobToPath("prod", "releases.jsonl", '{"seed":true}\n', "seed", { cwd: dir });
    expect((await pushLifecycleStatus({ cwd: dir })).status).toBe("pushed");

    // A second checkout records and pushes, and the first never fetches it:
    // the fetch before the spend is pointed somewhere unreadable, the push
    // back at the real remote.
    const other = tmp("other");
    git(["clone", "-q", remote, other], tmpdir());
    identity(other);
    git(["fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle"], other);
    await writeBlobToPath("prod", "releases.jsonl", '{"seed":true}\n{"other":true}\n', "other", { cwd: other });
    expect((await pushLifecycleStatus({ cwd: other })).status).toBe("pushed");

    git(["remote", "set-url", "origin", join(remote, "gone")], dir);
    git(["remote", "set-url", "--push", "origin", remote], dir);
    await expect(spendGatedRequest(spend(dir))).rejects.toThrow(/recorded as spent and not pushed .*stale info.*so nothing may apply under it/s);
  });
});
