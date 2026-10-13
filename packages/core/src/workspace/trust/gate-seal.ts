/**
 * A gate approval's seal (#3163, ws-080), checked with node:crypto (#3763).
 *
 * `chant approve --sign` seals an approval with `ssh-keygen -Y sign` in the
 * `chant-gate` namespace, over {@link gateSealPayload}. Signing shells to
 * ssh-keygen; checking does not. This module checks a seal with node:crypto
 * and no zod, and `checkGateSeal` (`./seal.ts`) and `sealedApprovalRule` use
 * it, so an apply job needs no ssh-keygen. A tool that decides a gate from one bundled file
 * (terragucci's apply job) runs the same rule: `@intentius/chant/gate-decision`
 * exports it.
 *
 * An SSHSIG (OpenSSH's PROTOCOL.sshsig) holds the public key, the namespace,
 * the hash algorithm and the signature over `"SSHSIG"`, the namespace, the
 * reserved field, the algorithm and the message's hash. Ed25519, ECDSA (P-256,
 * P-384, P-521), RSA with SHA-2, and the security-key forms of Ed25519 and
 * P-256 verify, with the touch flag required, as ssh-keygen requires it for a
 * signers line with no `no-touch-required` option (which the signers parser
 * does not accept). An RSA signature over SHA-1 does not verify.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { Signer } from "./trust-files";

/**
 * The ssh signature namespace of a gate approval's seal (#3163, ws-080), so a
 * verdict, record or commit signature can't stand in for one.
 */
export const GATE_SEAL_NAMESPACE = "chant-gate";

/** The gate approval a seal covers (#3163): the fields of a gate resolution line that say what was approved, by whom and when. */
export interface SealedGateApproval {
  op: string;
  gate: string;
  environment?: string;
  planDigest?: string;
  resolvedBy: string;
  /** Who relayed the approval for `resolvedBy` (#3402), when someone did. */
  relayedBy?: string;
  timestamp: string;
  /** The checkpoint the approval lets a run resume from (#3947), when it carries one. */
  checkpointDigest?: string;
  seal?: unknown;
}

/**
 * The version of a seal over `a` (#3947): 2 when the approval carries a
 * checkpoint digest, which the payload signs, and 1 otherwise. `chant approve
 * --sign` records 2 on the seal; a seal records no version for 1.
 */
export function gateSealVersion(a: Pick<SealedGateApproval, "checkpointDigest">): 1 | 2 {
  return a.checkpointDigest !== undefined ? 2 : 1;
}

/**
 * The bytes a gate approval's seal signs (#3163): the op (or component), the
 * gate, the environment, the plan digest, the approver and the time, joined
 * by LF with no final newline. An approval that binds no environment or plan
 * signs an empty line for it. A relayed approval (#3402) signs a seventh line,
 * `relayed-by <principal>`, so the relay can't be added, changed or removed
 * after sealing; an approval nobody relayed signs the six lines it always did,
 * so seals made before #3402 still verify.
 *
 * Seal version 2 (#3947) adds the checkpoint a resumed run carries its step
 * outputs from: an approval with a `checkpointDigest` signs one more line,
 * `checkpoint <digest>`, last. The values the steps after the gate read are
 * then covered by the seal too, and removing or swapping the digest stops it
 * verifying. An approval with none signs what a version 1 seal signed.
 */
export function gateSealPayload(a: SealedGateApproval): Buffer {
  const relay = a.relayedBy !== undefined ? `\nrelayed-by ${a.relayedBy}` : "";
  const checkpoint = gateSealVersion(a) === 2 ? `\ncheckpoint ${a.checkpointDigest}` : "";
  return Buffer.from(`${a.op}\n${a.gate}\n${a.environment ?? ""}\n${a.planDigest ?? ""}\n${a.resolvedBy}\n${a.timestamp}${relay}${checkpoint}`, "utf-8");
}

// ── SSHSIG ───────────────────────────────────────────────────────────────

/** A reader over ssh wire format: `take(n)` bytes, or `take()` one length-prefixed string. */
function reader(buf: Buffer): (n?: number) => Buffer {
  let at = 0;
  const take = (n?: number): Buffer => {
    const len = n ?? take(4).readUInt32BE(0);
    if (at + len > buf.length) throw new Error("the signature is truncated");
    return buf.subarray(at, (at += len));
  };
  return take;
}

const wire = (b: Buffer | string): Buffer => {
  const v = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(v.length);
  return Buffer.concat([n, v]);
};
const hash = (alg: string, b: Buffer): Buffer => createHash(alg).update(b).digest();
const b64url = (b: Buffer): string => b.toString("base64url");
/** An mpint without its sign byte, left-padded to `size` bytes when given. */
const unsigned = (b: Buffer, size?: number): Buffer => {
  let v = b;
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return size === undefined || v.length >= size ? v : Buffer.concat([Buffer.alloc(size - v.length), v]);
};

/** `SHA256:<base64>`, the fingerprint ssh-keygen prints for a public key blob. */
export function sshKeyFingerprint(blob: Buffer): string {
  return `SHA256:${hash("sha256", blob).toString("base64").replace(/=+$/, "")}`;
}

const CURVES: Record<string, { crv: string; size: number; hash: string }> = {
  nistp256: { crv: "P-256", size: 32, hash: "sha256" },
  nistp384: { crv: "P-384", size: 48, hash: "sha384" },
  nistp521: { crv: "P-521", size: 66, hash: "sha512" },
};

/** The key a public key blob holds, what it signs with, and the security key's application when it is one. */
function publicKey(blob: Buffer): { type: string; key: KeyObject; ecdsa?: { size: number; hash: string }; application?: Buffer } {
  const take = reader(blob);
  const type = take().toString();
  if (type === "ssh-ed25519" || type === "sk-ssh-ed25519@openssh.com") {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(take()) }, format: "jwk" });
    return { type, key, ...(type.startsWith("sk-") ? { application: take() } : {}) };
  }
  if (type.startsWith("ecdsa-sha2-") || type === "sk-ecdsa-sha2-nistp256@openssh.com") {
    const curve = CURVES[take().toString()];
    if (!curve) throw new Error(`unsupported curve in ${type}`);
    const q = take();
    if (q[0] !== 4 || q.length !== 1 + 2 * curve.size) throw new Error("the ECDSA key is not an uncompressed point");
    const key = createPublicKey({
      key: { kty: "EC", crv: curve.crv, x: b64url(q.subarray(1, 1 + curve.size)), y: b64url(q.subarray(1 + curve.size)) },
      format: "jwk",
    });
    return { type, key, ecdsa: curve, ...(type.startsWith("sk-") ? { application: take() } : {}) };
  }
  if (type === "ssh-rsa") {
    const e = unsigned(take());
    const n = unsigned(take());
    return { type, key: createPublicKey({ key: { kty: "RSA", e: b64url(e), n: b64url(n) }, format: "jwk" }) };
  }
  throw new Error(`unsupported key type ${type}`);
}

/** What {@link verifySshSignatureWith} found. */
export type SshSignatureCheck = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Whether `armored`, an SSHSIG as `ssh-keygen -Y sign` writes it, signs
 * `message` in `namespace` with one of `keys` (public key blobs, ssh wire
 * format). Never throws. On success, `key` is the signing key's fingerprint.
 */
export function verifySshSignatureWith(armored: string, message: Buffer, namespace: string, keys: readonly Buffer[]): SshSignatureCheck {
  try {
    const body = /-----BEGIN SSH SIGNATURE-----([^-]*)-----END SSH SIGNATURE-----/.exec(armored)?.[1];
    if (body === undefined) return { ok: false, reason: "it is not an armored ssh signature" };
    const take = reader(Buffer.from(body.replace(/\s+/g, ""), "base64"));
    if (take(6).toString() !== "SSHSIG" || take(4).readUInt32BE(0) !== 1) return { ok: false, reason: "it is not an SSHSIG, version 1" };
    const pk = take();
    const ns = take();
    const reserved = take();
    const alg = take().toString();
    const sigWire = take();
    if (ns.toString() !== namespace) return { ok: false, reason: `it is signed in the ${ns.toString()} namespace, not ${namespace}` };
    if (alg !== "sha256" && alg !== "sha512") return { ok: false, reason: `it hashes with ${alg}, and only sha256 and sha512 are accepted` };
    if (!keys.some((k) => k.equals(pk))) return { ok: false, reason: "signed by a key the policy at base does not list for the approver" };
    let data = Buffer.concat([Buffer.from("SSHSIG"), wire(ns), wire(reserved), wire(alg), wire(hash(alg, message))]);
    const { type, key, ecdsa, application } = publicKey(pk);
    const sig = reader(sigWire);
    const sigType = sig().toString();
    const raw = sig();
    const fingerprint = sshKeyFingerprint(pk);
    const answer = (ok: boolean): SshSignatureCheck => (ok ? { ok: true, key: fingerprint } : { ok: false, reason: "the signature does not match the signed fields" });
    if (type === "ssh-rsa") {
      if (sigType !== "rsa-sha2-256" && sigType !== "rsa-sha2-512") return { ok: false, reason: `an RSA signature of type ${sigType} is not accepted` };
      return answer(verify(`sha${sigType.slice(9)}`, data, key, raw));
    }
    if (sigType !== type) return { ok: false, reason: `a ${sigType} signature from a ${type} key` };
    if (application !== undefined) {
      // A security key signs its application, its flags and counter, then the data's hash; ssh-keygen requires the touch flag.
      const flags = sig(1);
      if (!(flags[0]! & 1)) return { ok: false, reason: "the security key was not touched (the user-presence flag is unset)" };
      data = Buffer.concat([hash("sha256", application), flags, sig(4), hash("sha256", data)]);
    }
    if (ecdsa) {
      const rs = reader(raw);
      const r = unsigned(rs(), ecdsa.size);
      const s = unsigned(rs(), ecdsa.size);
      return answer(verify(application !== undefined ? "sha256" : ecdsa.hash, data, { key, dsaEncoding: "ieee-p1363" }, Buffer.concat([r, s])));
    }
    return answer(verify(null, data, key, raw));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The key blob an armored SSHSIG carries, or null when it is not one. For
 * `ssh-keygen -Y check-novalidate`'s question, whether the signature is
 * intact whoever's key it is: verify against this key.
 */
export function sshSignatureKey(armored: string): Buffer | null {
  try {
    const body = /-----BEGIN SSH SIGNATURE-----([^-]*)-----END SSH SIGNATURE-----/.exec(armored)?.[1];
    if (body === undefined) return null;
    const take = reader(Buffer.from(body.replace(/\s+/g, ""), "base64"));
    if (take(6).toString() !== "SSHSIG" || take(4).readUInt32BE(0) !== 1) return null;
    return Buffer.from(take());
  } catch {
    return null;
  }
}

// ── the rule ─────────────────────────────────────────────────────────────

/**
 * The signers a sealed gate is judged by, read at base. chant's own
 * `TrustPolicy` (`./policy.ts`) is one; `gateSignersAt` in
 * `@intentius/chant/gate-decision` reads one without zod.
 */
export interface GateSigners {
  /** The commit the signers were read at, or null when there is no base. */
  base: string | null;
  /** The signers path used. */
  signersPath: string;
  /** Whether a signers file exists at base. False: no seal verifies, so a sealed gate passes nothing. */
  active: boolean;
  signers: Signer[];
  /** Why the trust config could not be read, when it could not. `active` is false then. */
  problems: string[];
}

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/** Whether ssh-keygen's `namespaces="..."` pattern list admits `namespace`: a `*`/`?` pattern matches, and a `!` pattern that matches refuses. */
export function namespaceAllowed(list: string | undefined, namespace: string): boolean {
  if (list === undefined) return true;
  let allowed = false;
  for (const raw of list.split(",")) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (!re.test(namespace)) continue;
    if (negated) return false;
    allowed = true;
  }
  return allowed;
}

/**
 * Why this approval does not count toward a sealed gate, or null when it
 * does: its seal verifies, for the approver it names, against a key `signers`
 * lists for that approver in the `chant-gate` namespace. With no signers file
 * at base, nothing counts. The same rule as `sealedApprovalRule` in
 * `../../op/gate-review.ts`, which checks with ssh-keygen.
 */
export function gateSealRefusal(signers: GateSigners, a: SealedGateApproval): string | null {
  const where = `${signers.signersPath} at base`;
  if (!signers.active) {
    const why = signers.problems.length > 0 ? `: ${signers.problems.join("; ")}` : "";
    return `the gate is sealed, and there is no signers file (${signers.signersPath}) at base ${signers.base?.slice(0, 12) ?? ""}`.trim() + why;
  }
  const what = `the approval of gate ${a.gate} by ${a.resolvedBy}`;
  if (a.seal === undefined || a.seal === null) return `${what} carries no seal`;
  const seal = a.seal as { signer?: unknown; signature?: unknown };
  if (typeof seal !== "object" || Array.isArray(seal) || typeof seal.signer !== "string" || typeof seal.signature !== "string") {
    return `the seal on ${what} is malformed: it needs signer and signature`;
  }
  if (normalise(seal.signer) !== normalise(a.resolvedBy)) return `the seal on ${what} is by ${seal.signer}, and its approver is ${a.resolvedBy || "empty"}`;
  const keys = signers.signers
    .filter((s) => normalise(s.principal) === normalise(a.resolvedBy) && namespaceAllowed(s.namespaces, GATE_SEAL_NAMESPACE))
    .map((s) => Buffer.from(s.key.split(" ")[1] ?? "", "base64"));
  if (keys.length === 0) return `${a.resolvedBy} has no key in ${where}, so the seal can't count`;
  const r = verifySshSignatureWith(seal.signature, gateSealPayload(a), GATE_SEAL_NAMESPACE, keys);
  return r.ok ? null : `the seal does not verify for ${a.resolvedBy} against ${where}: ${r.reason}`;
}
