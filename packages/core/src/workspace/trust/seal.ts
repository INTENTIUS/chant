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
 *
 * A record's author seal (#2688) works the same way, in its own namespace,
 * `chant-record`. It sits in the record's top-level `seal` field, which the
 * digest also leaves out, and signs the record id, the digest, the author
 * (the kind's `reviews.decider` field, `decided_by` for decisions) and the
 * state. An amendment moves the digest, so it has to be signed again.
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

/** The ssh signature namespace of a record's author seal (#2688). */
export const RECORD_SEAL_NAMESPACE = "chant-record";

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

/**
 * The bytes a record's author seal signs (#2688): the id, the digest, the
 * author and the state, joined by LF with no final newline. A kind without
 * states signs an empty last line.
 */
export function recordSealPayload(record: string, digest: string, author: string, state: string | null): Buffer {
  return Buffer.from(`${record}\n${digest}\n${author}\n${state ?? ""}`, "utf-8");
}

/** The record an author seal covers (#2688). */
export interface SealedRecord {
  record: string | null;
  digest: string;
  /** The author as the record names them, or null when it names none. */
  author: string | null;
  /** The kind's field that names the author, for messages. */
  authorField: string;
  state: string | null;
  seal: unknown;
}

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

const FINGERPRINT = /key (SHA256:[A-Za-z0-9+/=]+)/;

/** What {@link checkSeal} needs to know of the thing sealed. */
interface SealSubject {
  /** Who must have signed, as the thing names them. */
  principal: string;
  /** "the verdict by alice", "ws-003": what messages call it. */
  what: string;
  /** "reviewer", "decided_by": what messages call the principal's role. */
  role: string;
  namespace: string;
  seal: unknown;
  /** The signed bytes, or a message saying which covered value is missing. */
  payload: Buffer | string;
}

/**
 * Check a verdict's seal. With a signers file active at base, it verifies
 * against the keys listed there for the reviewer. With none, a seal present
 * is checked for integrity only (`ssh-keygen -Y check-novalidate`): nothing
 * says whose key it is.
 */
export function checkVerdictSeal(policy: TrustPolicy, v: SealedVerdict): SealCheck {
  const covered = v.record === null || v.digest === null || typeof v.on !== "string";
  return checkSeal(policy, {
    principal: v.reviewer,
    what: `the verdict by ${v.reviewer}`,
    role: "reviewer",
    namespace: REVIEW_SEAL_NAMESPACE,
    seal: v.seal,
    payload: covered
      ? `a seal covers the record id, the verdict's digest and on, and the verdict by ${v.reviewer} lacks one`
      : reviewSealPayload(v.record!, v.digest!, v.verdict, v.reviewer, v.on as string),
  });
}

/**
 * Check a record's author seal (#2688), as a verdict's is checked, over
 * {@link recordSealPayload} in the `chant-record` namespace. A record that
 * names no author and carries no seal is `seal-missing` with `attested`
 * null even under an active policy: it claims no author to attest.
 */
export function checkRecordSeal(policy: TrustPolicy, r: SealedRecord): SealCheck {
  const what = r.record ?? "the record";
  if (r.author === null && (r.seal === undefined || r.seal === null)) {
    return { attested: null, code: "seal-missing", message: `${what} names no ${r.authorField}, so it claims no author to seal` };
  }
  return checkSeal(policy, {
    principal: r.author ?? "",
    what,
    role: r.authorField,
    namespace: RECORD_SEAL_NAMESPACE,
    seal: r.seal,
    payload:
      r.record === null || r.author === null
        ? `a record's seal covers its id and its ${r.authorField}, and ${what} lacks one`
        : recordSealPayload(r.record, r.digest, r.author, r.state),
  });
}

function checkSeal(policy: TrustPolicy, s: SealSubject): SealCheck {
  const where = `${policy.signersPath} at base`;
  if (s.seal === undefined || s.seal === null) {
    return policy.active
      ? { attested: false, code: "seal-missing", message: `${s.what} carries no seal` }
      : { attested: null, code: "seal-missing", message: `${s.what} carries no seal; there is no signers file at base, so none is needed` };
  }
  const seal = s.seal as Partial<Record<keyof VerdictSeal, unknown>>;
  if (typeof seal !== "object" || Array.isArray(seal) || typeof seal.signer !== "string" || typeof seal.signature !== "string") {
    return { attested: false, code: "seal-signature-invalid", message: `the seal on ${s.what} is malformed: it needs signer and signature` };
  }
  if (normalise(seal.signer) !== normalise(s.principal)) {
    return {
      attested: false,
      code: "seal-signature-invalid",
      message: s.role === "reviewer" ? `the seal is by ${seal.signer}, and the verdict is ${s.principal}'s` : `the seal on ${s.what} is by ${seal.signer}, and its ${s.role} is ${s.principal || "empty"}`,
    };
  }
  if (typeof s.payload === "string") return { attested: false, code: "seal-signature-invalid", message: s.payload };
  if (!policy.active) return checkIntegrity(s.principal, s.payload, seal.signature, s.namespace);
  const listed = policy.signers.filter((x) => normalise(x.principal) === normalise(s.principal));
  if (listed.length === 0) {
    return { attested: false, code: "seal-signer-unlisted", message: `${s.principal} has no key in ${where}, so the seal can't count` };
  }
  const r = verifySshSignature(listed, s.payload, seal.signature, s.namespace);
  if (r.ok) return { attested: true, message: `sealed by ${r.principal}${r.key ? ` with ${r.key}` : ""}, a signer ${where} lists`, ...(r.key ? { key: r.key } : {}) };
  if (r.missing) return { attested: null, code: "seal-unverifiable", message: `the seal by ${s.principal} can't be checked here: ${r.reason}` };
  return { attested: false, code: "seal-signature-invalid", message: `the seal does not verify for ${s.principal} against ${where}: ${r.reason}` };
}

/** A seal checked with no signers file: is the signature over these bytes intact? */
function checkIntegrity(principal: string, payload: Buffer, signature: string, namespace: string): SealCheck {
  const dir = mkdtempSync(join(tmpdir(), "chant-seal-"));
  try {
    const sigFile = join(dir, "signature");
    writeFileSync(sigFile, signature);
    const r = sshKeygen(["-Y", "check-novalidate", "-n", namespace, "-s", sigFile], payload);
    if (r.missing) return { attested: null, code: "seal-unverifiable", message: `the seal by ${principal} can't be checked here: ssh-keygen is not installed` };
    if (r.status !== 0) {
      return { attested: false, code: "seal-signature-invalid", message: `the seal by ${principal} does not verify over ${namespace === RECORD_SEAL_NAMESPACE ? "this record" : "this verdict"}, even without a signers file` };
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
  return sign(keyFile, reviewSealPayload(v.record, v.digest, v.verdict, v.reviewer, v.on), REVIEW_SEAL_NAMESPACE, v.reviewer);
}

/**
 * Seal a record's author (#2688) with the key in `keyFile`, over
 * {@link recordSealPayload}. Throws a {@link SealError}.
 */
export function sealRecord(keyFile: string, r: { record: string; digest: string; author: string; state: string | null }): VerdictSeal {
  return sign(keyFile, recordSealPayload(r.record, r.digest, r.author, r.state), RECORD_SEAL_NAMESPACE, r.author);
}

function sign(keyFile: string, payload: Buffer, namespace: string, signer: string): VerdictSeal {
  const signed = sshKeygen(["-q", "-Y", "sign", "-n", namespace, "-f", keyFile], payload);
  if (signed.missing) throw new SealError("--sign needs ssh-keygen, and it is not installed here");
  if (signed.status !== 0 || !signed.stdout.startsWith("-----BEGIN SSH SIGNATURE-----")) {
    throw new SealError(`ssh-keygen could not sign with ${keyFile}: ${signed.stderr.trim() || `exit ${signed.status}`}`);
  }
  // The fingerprint, read back from the signature itself.
  const dir = mkdtempSync(join(tmpdir(), "chant-seal-"));
  try {
    const sigFile = join(dir, "signature");
    writeFileSync(sigFile, signed.stdout);
    const check = sshKeygen(["-Y", "check-novalidate", "-n", namespace, "-s", sigFile], payload);
    const key = FINGERPRINT.exec(check.stdout + check.stderr)?.[1];
    if (check.status !== 0 || !key) throw new SealError(`the signature ssh-keygen made with ${keyFile} does not check: ${check.stderr.trim()}`);
    return { signer, key, signature: signed.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
