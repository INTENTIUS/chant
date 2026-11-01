/**
 * Which releases are revoked (#4033, ws-105 question 2).
 *
 * A release traces to one commit (ws-104), and a commit is revoked when it
 * carries a `ci/revoked/<sha>` tag that counts (ws-103). So a release is
 * revoked exactly when its commit is, and this module derives that at read
 * time from the tags. Nothing is written when a commit is revoked: the tag is
 * the record, `chant ci tick` makes it once, and every reader below judges it
 * the same way.
 *
 * The tags are judged as `release cut` judges them (#4031): with
 * `ci.green.signedSince` declared, a revoked tag without a valid runner
 * statement is ignored and revokes nothing. The declaration and the runner
 * keys are read at base, the green branch's tip on `origin` (or the local
 * branch, or `HEAD`). Only local tags are read; nothing is fetched.
 *
 * The readers:
 *
 * - `chant approve` refuses a release gate whose release is revoked
 *   (`release-revoked`), and `chant components promote --release` refuses to
 *   deploy one, so a pending gate for it can never pass.
 * - `chant workspace status --json` reads such a gate as `superseded` and
 *   flags a component whose environment runs a revoked release, with the
 *   rollback line.
 * - `chant release list` marks a revoked release.
 */

import { execFileSync } from "node:child_process";
import type { CiGreen } from "../workspace/declaration";
import type { CiTags, RevokedTagView } from "../workspace/ci-green";

/** A revoked release: the commit it was cut from and the revoked tag on it, as `ci list` shows the tag. */
export interface ReleaseRevocation extends RevokedTagView {
  /** The release's commit, which the tag names. */
  commit: string;
}

/** The stable code `approve` and `promote --release` refuse a revoked release with. */
export const RELEASE_REVOKED_CODE = "release-revoked";

function tryGit(top: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The ci tags at `top`, judged against `green` at base: the green branch's
 * tip on `origin`, else the local branch, else `HEAD`. With no `ci.green`
 * every tag counts. With `lane` (#4692), that lane's tags, `ci/green-<lane>/`
 * and `ci/revoked-<lane>/`. Throws `WorkspaceReadError` (`declaration-invalid`)
 * when `ci.green.signedSince` names no commit here.
 */
export async function judgedCiTags(top: string, green: CiGreen | null, lane?: string): Promise<CiTags> {
  const { readCiTags } = await import("../workspace/ci-green");
  const base = green
    ? (tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${green.branch}^{commit}`]) ??
      tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${green.branch}^{commit}`]) ??
      tryGit(top, ["rev-parse", "HEAD"]))
    : null;
  return readCiTags(top, green, base, lane);
}

/**
 * Every revoked commit in the repository holding `cwd`, keyed by its full
 * sha, with the declaration's `ci.green` read at base as `release cut` reads
 * it. Empty outside a git repository. Throws `WorkspaceReadError`
 * (`declaration-invalid`) when the tags can't be judged.
 */
export async function readRevokedCommits(cwd: string): Promise<Map<string, ReleaseRevocation>> {
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return new Map();
  const { scopeSource } = await import("../workspace/write-scope");
  return revokedCommitsAt(top, scopeSource(cwd).declaration?.ci?.green ?? null);
}

/** {@link readRevokedCommits} for a caller that has the git top and the declaration's `ci.green` at base already. */
export async function revokedCommitsAt(top: string, green: CiGreen | null): Promise<Map<string, ReleaseRevocation>> {
  const { revokedTagView } = await import("../workspace/ci-green");
  const out = new Map<string, ReleaseRevocation>();
  for (const [sha, counted] of (await judgedCiTags(top, green)).revoked) out.set(sha, { commit: sha, ...revokedTagView(sha, counted) });
  return out;
}

/** What a reader prints for a release it found revoked: the revocation, the release and its label. */
export interface RevokedRelease extends ReleaseRevocation {
  releaseDigest: string;
  /** The release's label, or null when its cuts gave it none. */
  label: string | null;
}

/**
 * A memoised lookup from a release digest to its revocation, for the member
 * whose ledger is read from `memberDir`: null when the release is not
 * revoked, or its file can't be read. `revoked` is called on the first
 * lookup only, so a reader that meets no release reads no tags, and no
 * release file is read while no commit is revoked.
 */
export function revokedReleaseLookup(
  memberDir: string,
  revoked: () => Promise<ReadonlyMap<string, ReleaseRevocation>>,
): (releaseDigest: string) => Promise<RevokedRelease | null> {
  const seen = new Map<string, Promise<RevokedRelease | null>>();
  let labels: Promise<Map<string, string>> | undefined;
  return (releaseDigest) => {
    let found = seen.get(releaseDigest);
    if (!found) {
      found = (async () => {
        const commits = await revoked();
        if (commits.size === 0) return null;
        const { readRelease, readCuts, labelsByDigest } = await import("./release-store");
        const loc = { cwd: memberDir };
        const release = await readRelease(releaseDigest, loc).catch(() => null);
        const r = release ? revocationOf(release, commits) : null;
        if (!r) return null;
        labels ??= readCuts(loc).then((c) => labelsByDigest(c.cuts), () => new Map<string, string>());
        return { ...r, releaseDigest, label: (await labels).get(releaseDigest) ?? null };
      })();
      seen.set(releaseDigest, found);
    }
    return found;
  };
}

/** Whether `release` is revoked: its commit's revoked tag, or null. */
export function revocationOf(release: { commit: string }, revoked: ReadonlyMap<string, ReleaseRevocation>): ReleaseRevocation | null {
  return revoked.get(release.commit) ?? null;
}

/** What failed, in words: `phase e2e failed in deploy-smoke (Op run r-12 in staging)`. */
export function describeRevocation(r: ReleaseRevocation): string {
  const run = r.run
    ? ` in ${r.run.name}${r.run.opRun ? ` (Op run ${r.run.opRun.id} in ${r.run.opRun.env})` : r.run.id !== null ? ` (run ${r.run.id})` : ""}`
    : "";
  return r.phase !== null ? `phase ${r.phase} failed${run}` : `a required phase failed${run}`;
}

/** The refusal `approve` and `promote --release` print for a revoked release, and the line that fixes it. */
export function revokedRefusal(release: { releaseDigest: string; label: string | null }, r: ReleaseRevocation, fix: string): { message: string; hint: string } {
  return {
    message:
      `release ${release.label ?? release.releaseDigest} was cut from commit ${r.commit.slice(0, 12)}, which ${r.tag} revokes ` +
      `(${describeRevocation(r)}), so it is not deployed and no approval of it counts [${RELEASE_REVOKED_CODE}]`,
    hint: fix,
  };
}
