/**
 * Verify a change against the policy at its base (#2524 D5, Threat model).
 *
 * This is what CI runs on a protected branch: every commit in `base..head` is
 * asked of the attestors with the policy read at base, so nothing the change
 * does to its own copy of the policy counts. A change that edits the policy
 * (the signers file or `.chant/trust.json`) is a protected write: every commit
 * that touches those files must be attested by a signer the base policy
 * trusts, and by an admin when the base policy grants the admin role.
 *
 * Attestation is opt-in (#2525 rule 6). Without a signers file at base the
 * check passes and says so, unless `--require attested` asks for more.
 */

import { execFileSync } from "node:child_process";
import { type CommitAttestor, type ProvenanceLevel } from "./attestor";
import { policyAtBase, commitProvenance, resolveBase, type BaseSource, type RecordProvenance } from "./provenance";
import { policyWriters, protectedPaths, type ExcludedSigner, type TrustPolicy } from "./policy";
import { fileAt, nextVersion, rotationPath, signerHistory } from "./rotation";

export interface CommitVerdict extends RecordProvenance {
  commit: string;
  subject: string;
  /** A merge that changes nothing of its own; its parents are checked instead. */
  skipped?: string;
}

export interface ProtectedWrite {
  commit: string;
  paths: string[];
  level: ProvenanceLevel;
  principal?: string;
  allowed: boolean;
  reason: string;
}

export interface ChangeReport {
  base: string | null;
  baseFrom: BaseSource | null;
  head: string | null;
  policy: {
    active: boolean;
    signersPath: string;
    principals: string[];
    excluded: ExcludedSigner[];
    writers: string[];
    problems: string[];
  };
  require: ProvenanceLevel | null;
  commits: CommitVerdict[];
  protectedPaths: string[];
  /** Protected paths whose content differs between the merge base and head. */
  protectedChanged: string[];
  protectedWrites: ProtectedWrite[];
  /** When the change edits the signer set: the version it proposes and who signed it (#2553). */
  rotation: { from: number; to: number; signedBy: string[] } | null;
  notes: string[];
  failures: string[];
  ok: boolean;
}

export interface VerifyOptions {
  repo: string;
  base?: string;
  head?: string;
  require?: ProvenanceLevel;
  attestors: readonly CommitAttestor[];
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Commits in `range` that change any of `paths`, each with the paths it
 * changes. Merges count only for what they change beyond every parent.
 */
export function commitsTouching(repo: string, range: string, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const log = git(repo, ["--literal-pathspecs", "log", "-c", "--name-only", "--no-renames", "--format=%x00%H", range, "--", ...paths]);
  const wanted = new Set(paths);
  let commit = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) commit = line.slice(1).trim();
    else if (line && wanted.has(line)) out.set(commit, [...(out.get(commit) ?? []), line]);
  }
  return out;
}

/** Whether a merge commit changes nothing beyond what its parents bring. */
function mergeWithoutOwnChanges(repo: string, commit: string, parents: number): boolean {
  if (parents < 2) return false;
  return git(repo, ["diff-tree", "-c", "--name-only", "--no-commit-id", "-r", commit]).trim() === "";
}

export function verifyChange(opts: VerifyOptions): ChangeReport {
  const { repo } = opts;
  const base = resolveBase(repo, opts.base);
  const policy: TrustPolicy = policyAtBase(repo, base);
  const report: ChangeReport = {
    base: base.commit,
    baseFrom: base.from,
    head: null,
    policy: {
      active: policy.active,
      signersPath: policy.signersPath,
      principals: [...new Set(policy.signers.map((s) => s.principal))].sort(),
      excluded: policy.excluded,
      writers: [...policyWriters(policy)].sort(),
      problems: policy.problems,
    },
    require: opts.require ?? null,
    commits: [],
    protectedPaths: protectedPaths(policy),
    protectedChanged: [],
    protectedWrites: [],
    rotation: null,
    notes: [],
    failures: [],
    ok: false,
  };
  const headRev = opts.head ?? "HEAD";
  let head: string | undefined;
  try {
    head = headRev.startsWith("-") ? undefined : git(repo, ["rev-parse", "--verify", "--quiet", `${headRev}^{commit}`]).trim() || undefined;
  } catch {
    head = undefined;
  }
  if (!base.commit) report.failures.push(base.problem ?? "no base revision");
  if (!head) report.failures.push(`--head ${headRev} names no commit in this repository`);
  if (!base.commit || !head) return report;
  report.head = head;
  if (policy.problems.length > 0) {
    report.failures.push(...policy.problems.map((p) => `the policy at base cannot be read, so nothing verifies: ${p}`));
    return report;
  }

  const mergeBase = git(repo, ["merge-base", base.commit, head]).trim();
  const changedPaths = git(repo, ["--literal-pathspecs", "diff", "--name-only", "--no-renames", mergeBase, head, "--", ...report.protectedPaths])
    .split("\n")
    .filter(Boolean);
  report.protectedChanged = changedPaths;

  if (!policy.active) {
    report.notes.push(`no signers file (${policy.signersPath}) at base ${base.commit.slice(0, 8)}: attestation is off and nothing is verified`);
    if (changedPaths.includes(policy.signersPath)) {
      report.notes.push(`this change adds ${policy.signersPath}; it applies to changes made after it is merged, never to this one`);
    }
    if (opts.require) report.failures.push(`--require ${opts.require} was given, and there is no signers file at base to attest anything`);
    report.ok = report.failures.length === 0;
    return report;
  }

  // Every commit in the change, judged by the policy at base.
  const listing = git(repo, ["rev-list", "--reverse", "--parents", `${base.commit}..${head}`]).split("\n").filter(Boolean);
  const verdicts = new Map<string, CommitVerdict>();
  for (const line of listing) {
    const [commit, ...parents] = line.split(" ");
    const subject = git(repo, ["log", "-1", "--format=%s", commit]).trim();
    const p = commitProvenance(repo, policy, commit, opts.attestors);
    const v: CommitVerdict = { ...p, commit, subject };
    if (p.level !== "attested" && mergeWithoutOwnChanges(repo, commit, parents.length)) {
      v.skipped = "a merge with no changes of its own; the commits it brings are checked instead";
    }
    verdicts.set(commit, v);
    report.commits.push(v);
  }

  // Protected writes: every commit that touches the policy needs a writer's signature.
  if (changedPaths.length > 0) {
    const writers = policyWriters(policy);
    const touching = commitsTouching(repo, `${base.commit}..${head}`, report.protectedPaths);
    if (touching.size === 0) {
      report.failures.push(`the policy files ${changedPaths.join(", ")} differ from base, and no commit in the change accounts for it`);
    }
    for (const [commit, paths] of touching) {
      const v = verdicts.get(commit) ?? { ...commitProvenance(repo, policy, commit, opts.attestors), commit, subject: "" };
      const allowed = v.level === "attested" && v.principal !== undefined && writers.has(v.principal);
      const who = policy.roles.admin?.length ? "an admin the policy at base names" : "a signer the policy at base lists";
      const reason = allowed
        ? `signed by ${v.principal}, ${who.replace(/^an? /, "")}`
        : v.level === "attested"
          ? `signed by ${v.principal}, who is not ${who}`
          : `${paths.join(", ")} is protected and needs a signature by ${who}: ${v.reason}`;
      report.protectedWrites.push({ commit, paths, level: v.level, ...(v.principal ? { principal: v.principal } : {}), allowed, reason });
      if (!allowed) report.failures.push(`${commit.slice(0, 8)} changes ${paths.join(", ")}: ${reason}`);
    }
  }

  // A new signer set must be signed by a threshold of the set at base (#2553).
  const rotation = rotationPath(policy.signersPath);
  if (changedPaths.includes(policy.signersPath) || changedPaths.includes(rotation)) {
    const next = { signers: fileAt(repo, head, policy.signersPath), rotation: fileAt(repo, head, rotation) };
    const latest = signerHistory(repo, base.commit, policy.signersPath).versions.at(-1);
    if (next.signers !== undefined && latest && latest.version > 0) {
      const v = nextVersion(latest, next, null);
      if ("reason" in v) report.failures.push(`the signer set at head is not a valid rotation of the set at base: ${v.reason}`);
      else if (v !== latest) report.rotation = { from: latest.version, to: v.version, signedBy: v.signedBy };
    }
  }

  if (opts.require) {
    for (const v of report.commits) {
      if (v.skipped || v.level === opts.require) continue;
      report.failures.push(`${v.commit.slice(0, 8)} is ${v.level}, and --require ${opts.require} was given: ${v.reason}`);
    }
  }
  report.ok = report.failures.length === 0;
  return report;
}
