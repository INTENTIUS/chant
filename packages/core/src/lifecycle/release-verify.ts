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
 * The gate a cut claims (#5177): a cut signed by chant 0.124.101 or newer
 * signs its green-gate record (`green`, `override`, `lane`) with the digest
 * (`releaseGateSealPayload`, `sealVersion: 2`), so a verified signature
 * vouches for the gate too, and `gate` reads `signed`. An older signature
 * still verifies over its four lines, and its gate reads `unsigned`: the
 * cut line's gate could have been changed after it was signed.
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
  /**
   * Whether the gate the verified cut records is covered by its signature
   * (#5177): `signed`, or `unsigned` for a cut signed before chant signed the
   * gate, and for a release with no verified cut. `reason` says which.
   */
  gate: { status: "signed" | "unsigned"; reason: string };
  /** Each cut, with the green gate it passed or the override it ran under (#5149, #4693) when it recorded one. */
  cuts: Array<Pick<ReleaseCut, "label" | "actor" | "timestamp" | "runId" | "green" | "override"> & { signatureCheck: ReleaseSignatureCheck }>;
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
    ...(c.green ? { green: c.green } : {}),
    ...(c.override ? { override: c.override } : {}),
    signatureCheck: atCommit(checkReleaseSignature(rule, c)),
  }));
  // #5177: a verified cut whose signature covers its gate is the one to show, else any verified cut.
  const verified = cuts.find((c) => c.signatureCheck.status === "verified" && c.signatureCheck.gate === "signed") ?? cuts.find((c) => c.signatureCheck.status === "verified");
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
    gate: gateOf(digestMatches ? verified : undefined),
    cuts,
  };
}

/** How the gate of `verified`, the cut whose signature verified, reads (#5177). */
function gateOf(verified: { actor: string; signatureCheck: ReleaseSignatureCheck } | undefined): ReleaseVerification["gate"] {
  if (!verified) return { status: "unsigned", reason: "no cut's signature verifies, so nothing vouches for the gate a cut records" };
  if (verified.signatureCheck.gate === "signed") return { status: "signed", reason: `the green gate the cut by ${verified.actor} records is covered by its signature` };
  return { status: "unsigned", reason: `the cut by ${verified.actor} was signed before chant signed the green gate, so its signature does not cover the gate the cut line records` };
}

/** One Sigstore bundle a publish recorded, and how its check went (#5164). */
export interface SigstoreCheck {
  /** The bundle: `<file>.sigstore.json`, `release.slsa.sigstore.json`, or an image's `cosign signature` or `SLSA provenance`. */
  name: string;
  /** The publish target's kind and name. */
  kind: string;
  target: string;
  attachment: "signature" | "attestation";
  /** What it signs, each name and digest. */
  signs: Array<{ name: string; digest: string }>;
  /** The identity it was checked against: a certificate's issuer and identity, or (#5458) the public key. */
  identity: import("./publish-signing").SigningIdentity | null;
  status: "verified" | "failed" | "unchecked";
  reason: string;
}

/** What `release verify --sigstore` adds: each bundle's check, and the outcome. */
export interface SigstoreVerification {
  /** `verified` when every bundle verifies; `failed` when one does not or can't be checked; `none` when the publish record holds none. */
  status: "verified" | "failed" | "none";
  checks: SigstoreCheck[];
  reason: string;
}

/**
 * The Sigstore bundles the publish record holds for `releaseDigest` (#5164):
 * each signature or attestation item of the newest revealed line of each
 * target, with its target's kind and name.
 */
export async function recordedSignatures(cwd: string, releaseDigest: string): Promise<Array<{ kind: string; target: string; item: import("./release-publish").PublishItem }>> {
  const { readPublishRecords } = await import("./publish-record");
  const records = await readPublishRecords(releaseDigest, { cwd }).catch(() => []);
  const newest = new Map<string, (typeof records)[number]>();
  for (const r of records) if (r.step === "revealed") newest.set(r.target, r);
  return [...newest.values()].flatMap((r) =>
    r.items.filter((i) => (i.attachment === "signature" || i.attachment === "attestation") && (i.signs?.length ?? 0) > 0).map((item) => ({ kind: r.kind, target: r.name, item })),
  );
}

/**
 * Check the Sigstore bundles a publish recorded for `releaseDigest`
 * (#5164). An image's are read from its registry by cosign. A forge
 * release's are read from `assetsDir`, where its assets were downloaded
 * (such as `gh release download <tag> -D <dir>`): each bundle must be the
 * bytes the record names, and a file beside it must be the digest it signs.
 * A keyless bundle is checked against `release.signing.identity` and
 * `issuer` when the config names them, else the ones the publish recorded:
 * a workflow of the repository the publish ran in. A key's bundle (#5458)
 * is checked with `release.signing.publicKey`, else the public key the
 * publish recorded, from the member, and without the transparency log when
 * the config says `rekor: false`.
 */
export async function verifySigstore(req: {
  cwd: string;
  releaseDigest: string;
  assetsDir?: string;
  verifier?: import("./publish-signing").SigstoreVerifier;
  env?: NodeJS.ProcessEnv;
}): Promise<SigstoreVerification> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { cosignVerifier, cosignPath, isKeyIdentity, resolveSigning } = await import("./publish-signing");
  const { bytesDigest } = await import("./publish-targets");
  const { loadChantConfig } = await import("../config");
  const recorded = await recordedSignatures(req.cwd, req.releaseDigest);
  if (recorded.length === 0) return { status: "none", checks: [], reason: "the publish record holds no Sigstore signature for this release" };
  const config = (await loadChantConfig(req.cwd).catch(() => null))?.config.release?.signing;
  const setting = resolveSigning(config ?? true, new Set());
  const env = req.env ?? process.env;
  const verifier = req.verifier ?? cosignVerifier(env, cosignPath(env), { tlog: setting.tlog });
  const missing = verifier.unavailable();
  const checks: SigstoreCheck[] = [];
  for (const { kind, target, item } of recorded) {
    const attachment = item.attachment as "signature" | "attestation";
    const signs = item.signs ?? [];
    const was = item.sigstore;
    let id: import("./publish-signing").SigningIdentity | null;
    if (setting.mode !== "keyless" || (was && isKeyIdentity(was))) {
      // A key's signature: the public key the config names, else the one recorded, from the member.
      const key = setting.publicKey ?? (was && isKeyIdentity(was) ? was.key : undefined);
      id = key ? { key: /^[a-z][a-z0-9+.-]*:\/\//i.test(key) ? key : resolve(req.cwd, key) } : null;
    } else {
      const recordedId = was && !isKeyIdentity(was) ? was : undefined;
      const issuer = setting.issuer ?? recordedId?.issuer;
      const identity = setting.identity ?? recordedId?.identity;
      id = issuer && identity ? { issuer, identity } : null;
    }
    const base = { name: item.name, kind, target, attachment, signs, identity: id };
    const done = (status: SigstoreCheck["status"], reason: string) => checks.push({ ...base, status, reason });
    if (!id) {
      done("unchecked", setting.mode === "keyless" ? "the record names no identity for it; set release.signing.identity and issuer" : "the record names no public key for it; set release.signing.publicKey");
      continue;
    }
    if (missing) {
      done("unchecked", missing);
      continue;
    }
    if (kind === "oci") {
      const ref = signs[0]!.name;
      const why = attachment === "signature" ? await verifier.verifyImage(ref, id) : await verifier.verifyImageAttestation(ref, item.predicateType ?? "", id);
      done(why ? "failed" : "verified", why ?? `${verifier.name} verified it on ${ref}`);
      continue;
    }
    if (!req.assetsDir) {
      done("unchecked", "it is a release asset; download the release's assets and pass --assets <dir>");
      continue;
    }
    const file = join(resolve(req.assetsDir), item.name);
    if (!existsSync(file)) {
      done("unchecked", `${item.name} is not in ${req.assetsDir}`);
      continue;
    }
    const bundle = new Uint8Array(readFileSync(file));
    if (item.digest && bytesDigest(bundle) !== item.digest) {
      done("failed", `${item.name} in ${req.assetsDir} is ${bytesDigest(bundle)}, and the publish uploaded ${item.digest}`);
      continue;
    }
    const changed = signs.find((s) => existsSync(join(resolve(req.assetsDir!), s.name)) && bytesDigest(new Uint8Array(readFileSync(join(resolve(req.assetsDir!), s.name)))) !== s.digest);
    if (changed) {
      done("failed", `${changed.name} in ${req.assetsDir} is not the ${changed.digest} the release published`);
      continue;
    }
    let why: string | null = null;
    for (const s of signs) {
      why = attachment === "signature" ? await verifier.verifyBlob(bundle, s.digest, id) : await verifier.verifyBlobAttestation(bundle, s.digest, item.predicateType ?? "", id);
      if (why) {
        why = `${s.name}: ${why}`;
        break;
      }
    }
    done(why ? "failed" : "verified", why ?? `${verifier.name} verified it for ${signs.map((s) => s.name).join(", ")}`);
  }
  const bad = checks.filter((c) => c.status !== "verified");
  return {
    status: bad.length === 0 ? "verified" : "failed",
    checks,
    reason: bad.length === 0 ? `${checks.length} Sigstore bundle(s) verified` : bad.map((c) => `${c.name} (${c.target}): ${c.status}, ${c.reason}`).join("; "),
  };
}
