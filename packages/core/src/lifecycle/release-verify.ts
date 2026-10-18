/**
 * `chant release verify <label|digest>` (#4049): whether a release was
 * signed by a key `.chant/allowed_signers` lists, checked offline.
 *
 * It reads the release and its cuts from the local `chant/lifecycle` branch,
 * and the signers file, its signed history (#2553) and the declaration at the
 * release's own commit, as `chant workspace evidence verify` reads the policy
 * at the revision it is given. It fetches nothing and needs no key. A release
 * verifies when its file's digest is the digest of what it holds and one of
 * its cuts carries a signature in the `chant-release` namespace that verifies
 * for the cut's actor, over the release digest, the label, the actor and the
 * time (`releaseSealPayload`), and, when the declaration at that commit has an
 * `identity.gates.release` entry naming a class, the actor is in it.
 *
 * Reading the signers at the release's commit means a key added later does
 * not make an old release verify, and one removed later does not unmake it.
 */

import type { ReleaseSignatureCheck } from "../workspace/identity-gate-rule";
import type { Release, ReleaseCut } from "./release-store";

/** What `release verify --json` prints. */
export interface ReleaseVerification {
  releaseDigest: string;
  label: string | null;
  member: string | null;
  commit: string;
  /** Where the signers were read: the signers file's path and the commit. */
  signers: { path: string; at: string; active: boolean };
  /** True when the release file's digest is the digest of what it holds. */
  digestMatches: boolean;
  /** `verified` when a cut's signature verifies; `unsigned` when no cut carries one; `unverified` otherwise. */
  status: "verified" | "unsigned" | "unverified";
  /** The cut whose signature verified, or null. */
  verifiedBy: { actor: string; key: string | null } | null;
  reason: string;
  cuts: Array<Pick<ReleaseCut, "label" | "actor" | "timestamp" | "runId"> & { signatureCheck: ReleaseSignatureCheck }>;
}

/** Why a release could not be checked at all. */
export interface ReleaseVerifyError {
  code: "release-not-found" | "release-commit-missing" | "trust-policy-unreadable" | "not-a-git-repository";
  message: string;
  fix?: string;
}

/** The exit-1 codes of a release that was checked and did not verify. */
export function verificationCode(v: ReleaseVerification): "release-digest-mismatch" | "release-unsigned" | "release-signature-unverified" | null {
  if (!v.digestMatches) return "release-digest-mismatch";
  if (v.status === "verified") return null;
  return v.status === "unsigned" ? "release-unsigned" : "release-signature-unverified";
}

/** Check the release `ref` names in the member at `cwd`. Reads only the local repository. */
export async function verifyRelease(req: { cwd: string; ref: string }): Promise<ReleaseVerification | { error: ReleaseVerifyError }> {
  const { resolveRelease, readCuts, verifyReleaseDigest } = await import("./release-store");
  const { gitRoot } = await import("../workspace/record-source");
  const { resolveBase } = await import("../workspace/trust/provenance");
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const { checkReleaseSignature } = await import("../workspace/identity-gate-rule");
  const { cwd, ref } = req;

  const top = gitRoot(cwd);
  if (!top) return { error: { code: "not-a-git-repository", message: "a release is checked against the signers file at its commit, and this directory is not in a git repository" } };
  const found = await resolveRelease(ref, { cwd });
  if (!found) return { error: { code: "release-not-found", message: `no release is labelled or digested "${ref}" in this member`, fix: "Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle), then list them with: chant release list" } };
  const release: Release = found.release;
  const at = resolveBase(top, release.commit).commit;
  if (!at) {
    return {
      error: {
        code: "release-commit-missing",
        message: `the release's commit ${release.commit} is not in this clone, so the signers file at it can't be read`,
        fix: `Fetch it: git fetch origin ${release.commit}`,
      },
    };
  }
  const source = scopeSource(cwd, at);
  if (source.policy.problems.length > 0) {
    return { error: { code: "trust-policy-unreadable", message: `the signers at ${at.slice(0, 12)} can't be read: ${source.policy.problems.join("; ")}` } };
  }
  const read = releaseRuleFrom(source);
  // A declaration read from the working tree is not the commit's, so its class does not apply.
  const rule = source.from === "base" ? read.rule : { ...read.rule, class: null };

  const own = (await readCuts({ cwd })).cuts.filter((c) => c.releaseDigest === release.releaseDigest);
  // The check words where it read the signers as "at base"; here that is the release's commit.
  const atCommit = (check: ReleaseSignatureCheck): ReleaseSignatureCheck => ({ ...check, reason: check.reason.split(`${rule.signers.signersPath} at base`).join(`${rule.signers.signersPath} at ${at.slice(0, 12)}`) });
  const cuts = own.map((c) => ({
    label: c.label,
    actor: c.actor,
    timestamp: c.timestamp,
    runId: c.runId ?? null,
    signatureCheck: atCommit(checkReleaseSignature(rule, { releaseDigest: c.releaseDigest, label: c.label, actor: c.actor, timestamp: c.timestamp, signature: c.signature })),
  }));
  const verified = cuts.find((c) => c.signatureCheck.status === "verified");
  const digestMatches = verifyReleaseDigest(release);
  const status: ReleaseVerification["status"] = verified ? "verified" : cuts.every((c) => c.signatureCheck.status === "unsigned") ? "unsigned" : "unverified";
  const where = `${rule.signers.signersPath} at ${at.slice(0, 12)}`;
  const reason = !digestMatches
    ? `the release file's digest ${release.releaseDigest} is not the digest of what it holds, so it was changed after the cut`
    : verified
      ? `${verified.signatureCheck.reason}, checked against ${where}`
      : status === "unsigned"
        ? `no cut of the release carries a signature`
        : cuts.map((c) => c.signatureCheck.reason).join("; ");
  return {
    releaseDigest: release.releaseDigest,
    label: found.label,
    member: release.member,
    commit: release.commit,
    signers: { path: rule.signers.signersPath, at, active: rule.signers.active },
    digestMatches,
    status: digestMatches ? status : "unverified",
    verifiedBy: digestMatches && verified ? { actor: verified.actor, key: verified.signatureCheck.key } : null,
    reason,
    cuts,
  };
}
