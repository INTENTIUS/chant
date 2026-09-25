/**
 * Sealed verdicts (#2687, part of #2547): a review entry signed by the
 * principal it names, so the quorum counts it only when that principal
 * signed it.
 *
 * A seal is a detached ssh signature, the same mechanism as the ssh-commit
 * attestor (./ssh-commit.ts): `ssh-keygen -Y sign` to make it, and
 * `ssh-keygen -Y verify` against the signers read at base to check it. It is
 * made in its own namespace, `chant-review`, so neither a commit signature
 * nor a signer-set signature can stand in for one.
 *
 * The signed bytes are the record id, the verdict's digest, the verdict, the
 * reviewer and the date, each on its own line with no final newline. The
 * digest is the record's text digest (`recordTextDigest`), so the seal binds
 * the verdict to the text it judged. The seal lives inside the reviews block,
 * which the digest leaves out, so sealing a verdict never moves the digest.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SealCode } from "../records";
import { type TrustPolicy } from "./policy";
import { sshKeygen, verifySshSignature } from "./ssh-commit";

/** The ssh signature namespace of a verdict seal. */
export const REVIEW_SEAL_NAMESPACE = "chant-review";

/** A seal as a review entry holds it. */
export interface VerdictSeal {
  /** The principal who signed: the reviewer, as the signers file names them. */
  signer: string;
  /** The signing key's fingerprint, such as `SHA256:...`. Reported, never trusted: the signature is the proof. */
  key: string;
  /** The armored ssh signature. */
  signature: string;
}

/** What a verdict's seal establishes. */
export interface SealCheck {
  /** true: the seal verifies for the reviewer against the signers at base. false: it is missing under an active policy, or it fails. null: nothing here can say. */
  attested: boolean | null;
  /** Why it is not attested. Absent when `attested` is true. */
  code?: SealCode;
  message: string;
  /** The fingerprint of the key that made the signature, when the signature was checked. */
  key?: string;
}

/** The verdict a seal covers. */
export interface SealedVerdict {
  record: string | null;
  reviewer: string;
  verdict: string;
  on: unknown;
  digest: string | null;
  seal: unknown;
}

/** The bytes a verdict seal signs. */
export function reviewSealPayload(record: string, digest: string, verdict: string, reviewer: string, on: string): Buffer {
  return Buffer.from(`${record}\n${digest}\n${verdict}\n${reviewer}\n${on}`, "utf-8");
}

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

const FINGERPRINT = /key (SHA256:[A-Za-z0-9+/=]+)/;

/**
 * Check a verdict's seal. With a signers file active at base, it verifies
 * against the keys listed there for the reviewer. With none, a seal present
 * is checked for integrity only (`ssh-keygen -Y check-novalidate`): nothing
 * says whose key it is.
 */
export function checkVerdictSeal(policy: TrustPolicy, v: SealedVerdict): SealCheck {
  const where = `${policy.signersPath} at base`;
  if (v.seal === undefined || v.seal === null) {
    return policy.active
      ? { attested: false, code: "seal-missing", message: `the verdict by ${v.reviewer} carries no seal` }
      : { attested: null, code: "seal-missing", message: `the verdict by ${v.reviewer} carries no seal; there is no signers file at base, so none is needed` };
  }
  const seal = v.seal as Partial<Record<keyof VerdictSeal, unknown>>;
  if (typeof seal !== "object" || Array.isArray(seal) || typeof seal.signer !== "string" || typeof seal.signature !== "string") {
    return { attested: false, code: "seal-signature-invalid", message: `the seal on the verdict by ${v.reviewer} is malformed: it needs signer and signature` };
  }
  if (normalise(seal.signer) !== normalise(v.reviewer)) {
    return { attested: false, code: "seal-signature-invalid", message: `the seal is by ${seal.signer}, and the verdict is ${v.reviewer}'s` };
  }
  if (v.record === null || v.digest === null || typeof v.on !== "string") {
    return { attested: false, code: "seal-signature-invalid", message: `a seal covers the record id, the verdict's digest and on, and the verdict by ${v.reviewer} lacks one` };
  }
  const payload = reviewSealPayload(v.record, v.digest, v.verdict, v.reviewer, v.on);
  if (!policy.active) return checkIntegrity(v.reviewer, payload, seal.signature);
  const listed = policy.signers.filter((s) => normalise(s.principal) === normalise(v.reviewer));
  if (listed.length === 0) {
    return { attested: false, code: "seal-signer-unlisted", message: `${v.reviewer} has no key in ${where}, so the seal can't count` };
  }
  const r = verifySshSignature(listed, payload, seal.signature, REVIEW_SEAL_NAMESPACE);
  if (r.ok) return { attested: true, message: `sealed by ${r.principal}${r.key ? ` with ${r.key}` : ""}, a signer ${where} lists`, ...(r.key ? { key: r.key } : {}) };
  if (r.missing) return { attested: null, code: "seal-unverifiable", message: `the seal by ${v.reviewer} can't be checked here: ${r.reason}` };
  return { attested: false, code: "seal-signature-invalid", message: `the seal does not verify for ${v.reviewer} against ${where}: ${r.reason}` };
}

/** A seal checked with no signers file: is the signature over these bytes intact? */
function checkIntegrity(reviewer: string, payload: Buffer, signature: string): SealCheck {
  const dir = mkdtempSync(join(tmpdir(), "chant-seal-"));
  try {
    const sigFile = join(dir, "signature");
    writeFileSync(sigFile, signature);
    const r = sshKeygen(["-Y", "check-novalidate", "-n", REVIEW_SEAL_NAMESPACE, "-s", sigFile], payload);
    if (r.missing) return { attested: null, code: "seal-unverifiable", message: `the seal by ${reviewer} can't be checked here: ssh-keygen is not installed` };
    if (r.status !== 0) {
      return { attested: false, code: "seal-signature-invalid", message: `the seal by ${reviewer} does not verify over this verdict, even without a signers file` };
    }
    const key = FINGERPRINT.exec(r.stdout + r.stderr)?.[1];
    return {
      attested: null,
      code: "seal-unverifiable",
      message: `the signature is intact${key ? ` (${key})` : ""}, and there is no signers file at base to say whose key it is`,
      ...(key ? { key } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Why a seal could not be made. */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/**
 * The key `--sign` names: the file given, or with none, git's
 * `user.signingkey` when `gpg.format` is `ssh`, as `git commit -S` reads it.
 * A literal public key (`key::ssh-...`, or `ssh-...`) signs through the ssh
 * agent holding its private half. Returns the file to pass to ssh-keygen,
 * and a cleanup for a temporary one.
 */
export function resolveSigningKey(sign: string | true, cwd: string): { file: string; cleanup: () => void } {
  const none = { cleanup: () => {} };
  if (sign !== true) return { file: resolve(cwd, expandHome(sign)), ...none };
  const config = (key: string): string | undefined => {
    try {
      return execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const format = config("gpg.format");
  const key = config("user.signingkey");
  if (format !== "ssh" || key === undefined) {
    throw new SealError(
      `--sign with no key file uses git's user.signingkey when gpg.format is ssh, and git has ${format === "ssh" ? "no user.signingkey" : `gpg.format ${format ?? "unset"}`}; pass --sign <key file>`,
    );
  }
  const literal = key.startsWith("key::") ? key.slice(5) : key.startsWith("ssh-") || key.startsWith("ecdsa-") || key.startsWith("sk-") ? key : undefined;
  if (literal === undefined) return { file: resolve(cwd, expandHome(key)), ...none };
  const dir = mkdtempSync(join(tmpdir(), "chant-sign-"));
  const file = join(dir, "key.pub");
  writeFileSync(file, `${literal}\n`);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Seal a verdict with the key in `keyFile` (a private key, or a public key
 * whose private half the ssh agent holds). Throws a {@link SealError}.
 */
export function sealVerdict(keyFile: string, v: { record: string; digest: string; verdict: string; reviewer: string; on: string }): VerdictSeal {
  const payload = reviewSealPayload(v.record, v.digest, v.verdict, v.reviewer, v.on);
  const signed = sshKeygen(["-q", "-Y", "sign", "-n", REVIEW_SEAL_NAMESPACE, "-f", keyFile], payload);
  if (signed.missing) throw new SealError("--sign needs ssh-keygen, and it is not installed here");
  if (signed.status !== 0 || !signed.stdout.startsWith("-----BEGIN SSH SIGNATURE-----")) {
    throw new SealError(`ssh-keygen could not sign with ${keyFile}: ${signed.stderr.trim() || `exit ${signed.status}`}`);
  }
  // The fingerprint, read back from the signature itself.
  const dir = mkdtempSync(join(tmpdir(), "chant-seal-"));
  try {
    const sigFile = join(dir, "signature");
    writeFileSync(sigFile, signed.stdout);
    const check = sshKeygen(["-Y", "check-novalidate", "-n", REVIEW_SEAL_NAMESPACE, "-s", sigFile], payload);
    const key = FINGERPRINT.exec(check.stdout + check.stderr)?.[1];
    if (check.status !== 0 || !key) throw new SealError(`the signature ssh-keygen made with ${keyFile} does not check: ${check.stderr.trim()}`);
    return { signer: v.reviewer, key, signature: signed.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
