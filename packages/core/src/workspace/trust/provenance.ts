/**
 * The provenance level of each record (#2524 D5, Threat model).
 *
 * A record's content comes from the last commit that changed its file. That
 * commit is asked of each attestor, with the policy read at base. A file with
 * uncommitted changes is `unattested`: its bytes are in no commit, so nothing
 * vouches for them.
 *
 * On a developer machine this detects; it does not enforce (ws-002). An agent
 * running as the developer can use an unlocked signing agent or skip the check.
 * Enforcement is CI running the same check against base.
 */

import { execFileSync } from "node:child_process";
import { gitRevisionSource } from "../record-source";
import { attestCommit, type CommitAttestor, type ProvenanceLevel } from "./attestor";
import { emptyPolicy, readTrustPolicy, type TrustPolicy } from "./policy";
import { SignerPositions, signerHistory } from "./rotation";

/** What `records` reports for one record. */
export interface RecordProvenance {
  level: ProvenanceLevel;
  /** The commit the record's content comes from, or null for uncommitted content. */
  commit: string | null;
  attestor?: string;
  principal?: string;
  key?: string;
  reason: string;
}

/** Where the base revision came from. */
export type BaseSource = "flag" | "origin/HEAD" | "main" | "master";

export interface ResolvedBase {
  commit: string | null;
  from: BaseSource | null;
  /** Why there is no base, when there is none. */
  problem?: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function tryCommit(repo: string, rev: string): string | undefined {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The base revision: `--base <rev>` when given, otherwise the target branch
 * tip, taken as `origin/HEAD`, then a local `main`, then `master`. Never
 * `HEAD`, which is the change under review.
 */
export function resolveBase(repo: string, explicit?: string): ResolvedBase {
  if (explicit !== undefined) {
    const c = explicit.startsWith("-") ? undefined : tryCommit(repo, explicit);
    return c ? { commit: c, from: "flag" } : { commit: null, from: null, problem: `--base ${explicit} names no commit in this repository` };
  }
  for (const [rev, from] of [
    ["refs/remotes/origin/HEAD", "origin/HEAD"],
    ["refs/heads/main", "main"],
    ["refs/heads/master", "master"],
  ] as const) {
    const c = tryCommit(repo, rev);
    if (c) return { commit: c, from };
  }
  return { commit: null, from: null, problem: "no base revision: pass --base <rev> (there is no origin/HEAD, main or master)" };
}

/**
 * The policy at `base`, or an inactive one when there is no base. With a
 * signers file, its history is verified too (#2553): every version must be
 * signed by a threshold of the one before, or nothing verifies.
 */
export function policyAtBase(repo: string, base: ResolvedBase): TrustPolicy {
  if (!base.commit) return emptyPolicy(null, base.problem ? [base.problem] : []);
  const policy = readTrustPolicy(gitRevisionSource(repo, base.commit), base.commit);
  if (!policy.active || policy.problems.length > 0) return policy;
  const history = signerHistory(repo, base.commit, policy.signersPath);
  if (history.broken) {
    const at = history.broken.commit ? ` at ${history.broken.commit.slice(0, 8)}` : "";
    return { ...policy, problems: [`the signer history of ${policy.signersPath} is broken${at}: ${history.broken.reason}`] };
  }
  const positions = new SignerPositions(repo, base.commit, history);
  return { ...policy, signersAt: (commit) => positions.versionFor(commit) };
}

/**
 * The last commit reachable from `rev` that changed each path. Merges are
 * diffed against all their parents (`-c`), so a merge that changes a file
 * beyond what either side brought is the commit that file comes from, and a
 * merge that only takes one side's version is passed through to that side.
 */
export function lastCommits(repo: string, rev: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const log = git(repo, ["--literal-pathspecs", "log", "-c", "--name-only", "--no-renames", "--format=%x00%H", rev, "--", ...paths]);
  const wanted = new Set(paths);
  let commit = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) commit = line.slice(1).trim();
    else if (line && wanted.has(line) && !out.has(line)) out.set(line, commit);
  }
  return out;
}

/** Paths with staged, unstaged or untracked changes in the working tree. */
export function dirtyPaths(repo: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const status = git(repo, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const dirty = new Set<string>();
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    dirty.add(p.slice(3));
    if (p[0] === "R" || p[0] === "C") i++;
  }
  return dirty;
}

function isAncestor(repo: string, a: string, b: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether `commit` lies in a range the policy adopts (`from..to`, exact). */
export function isAdopted(repo: string, policy: TrustPolicy, commit: string): boolean {
  return policy.adopted.some((r) => isAncestor(repo, commit, r.to) && (r.from === undefined || !isAncestor(repo, commit, r.from)));
}

/** A commit's provenance level under `policy`. */
export function commitProvenance(repo: string, policy: TrustPolicy, commit: string, attestors: readonly CommitAttestor[]): RecordProvenance {
  // Judge the commit by the signer set in effect where it entered the base's history (#2553).
  let judged = policy;
  if (policy.signersAt) {
    const v = policy.signersAt(commit);
    judged = { ...policy, signers: v?.signers ?? [] };
    if (!v || v.version === 0) {
      const none = "no signer set was in effect where this commit entered the base's history";
      if (isAdopted(repo, policy, commit)) return { level: "adopted", commit, reason: `in a commit range the policy at base adopts; ${none}` };
      return { level: "unattested", commit, reason: none };
    }
  }
  const a = attestCommit({ repo, policy: judged }, commit, attestors);
  if (a.level === "unattested" && isAdopted(repo, policy, commit)) {
    return { level: "adopted", commit, attestor: a.attestor, reason: `in a commit range the policy at base adopts; ${a.reason}` };
  }
  return {
    level: a.level,
    commit,
    attestor: a.attestor,
    ...(a.principal ? { principal: a.principal } : {}),
    ...(a.key ? { key: a.key } : {}),
    reason: a.reason,
  };
}

export interface ProvenanceQuery {
  repo: string | undefined;
  policy: TrustPolicy;
  /** The commit records were read at, or null for the working tree. */
  at: string | null;
  paths: string[];
  attestors: readonly CommitAttestor[];
}

/**
 * The provenance of each path. With attestation off (no signers file at
 * base) nothing is checked and every path is `unattested`.
 */
export function recordProvenance(q: ProvenanceQuery): Map<string, RecordProvenance> {
  const out = new Map<string, RecordProvenance>();
  const all = (reason: string) => {
    for (const p of q.paths) out.set(p, { level: "unattested", commit: null, reason });
    return out;
  };
  if (!q.repo) return all("not in a git repository");
  if (q.policy.problems.length > 0) return all(q.policy.problems.join("; "));
  if (!q.policy.active) return all(`no signers file (${q.policy.signersPath}) at base ${q.policy.base?.slice(0, 8)}; attestation is off`);

  const dirty = q.at === null ? dirtyPaths(q.repo, q.paths) : new Set<string>();
  const commits = lastCommits(q.repo, q.at ?? "HEAD", q.paths.filter((p) => !dirty.has(p)));
  for (const p of q.paths) {
    if (dirty.has(p)) {
      out.set(p, { level: "unattested", commit: null, reason: "the working tree has uncommitted changes to this file" });
      continue;
    }
    const c = commits.get(p);
    if (!c) {
      out.set(p, { level: "unattested", commit: null, reason: "no commit holds this file" });
      continue;
    }
    out.set(p, commitProvenance(q.repo, q.policy, c, q.attestors));
  }
  return out;
}
