/**
 * DSSE envelopes (https://github.com/secure-systems-lab/dsse, v1) signed with
 * Ed25519 runner keys (#2553).
 *
 * The signature covers the pre-authentication encoding (PAE) of the payload
 * type and the payload, never the payload alone, so an envelope cannot be
 * replayed under another type. Everything here runs offline: verifying needs
 * the envelope and the public key, nothing else.
 *
 * Public keys are written the way ssh writes them (`ssh-ed25519 AAAA...`), so
 * the runner keys in `.chant/trust.json` read like the signers file beside
 * them, and a key id is the key's ssh fingerprint (`SHA256:...`).
 *
 * A signature can instead be keyless (#4869, ./keyless.ts): it carries the
 * short-lived certificate of a CI job's OIDC identity and a timestamp, and
 * verifies against an identity the policy lists rather than a key.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { isKeylessSignature, verifyKeylessSignature, type TrustedIdentity } from "./keyless";

export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export interface DsseSignature {
  keyid: string;
  sig: string;
  /** Keyless (#4869): the certificate chain, base64 DER, the signing certificate first. */
  certificates?: string[];
  /** Keyless (#4869): the RFC 3161 timestamp token over the signature, base64 DER. */
  timestamp?: string;
}

export interface DsseEnvelope {
  payloadType: string;
  /** Base64 of the payload bytes. */
  payload: string;
  signatures: DsseSignature[];
}

/** DSSE v1 pre-authentication encoding. Lengths are byte lengths in ASCII decimal. */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type, Buffer.from(` ${payload.length} `, "utf8"), payload]);
}

// ── ssh-ed25519 public keys ──────────────────────────────────────────────────

function sshString(buf: Buffer, at: number): { value: Buffer; next: number } {
  if (at + 4 > buf.length) throw new Error("truncated key");
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) throw new Error("truncated key");
  return { value: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

/** The 32 raw bytes of an `ssh-ed25519 <base64>` public key. */
export function ed25519FromSsh(line: string): Buffer {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !b64) throw new Error("runner keys must be ssh-ed25519 public keys");
  const blob = Buffer.from(b64, "base64");
  const t = sshString(blob, 0);
  if (t.value.toString("utf8") !== "ssh-ed25519") throw new Error("the key blob is not ssh-ed25519");
  const k = sshString(blob, t.next);
  if (k.value.length !== 32 || k.next !== blob.length) throw new Error("not a 32-byte ed25519 key");
  return Buffer.from(k.value);
}

/** An `ssh-ed25519 <base64>` line for 32 raw public key bytes. */
export function sshFromEd25519(raw: Buffer): string {
  const part = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([part(Buffer.from("ssh-ed25519")), part(raw)]).toString("base64")}`;
}

/** The ssh fingerprint of a public key line: `SHA256:` and unpadded base64. */
export function sshFingerprint(line: string): string {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function publicKeyObject(line: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: ed25519FromSsh(line).toString("base64url") }, format: "jwk" });
}

/** A private Ed25519 key from PEM (PKCS#8), and its public half as an ssh line. */
export function loadRunnerKey(pem: string): { key: KeyObject; publicKey: string } {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`runner keys must be Ed25519, not ${key.asymmetricKeyType}`);
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return { key, publicKey: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

// ── Sign and verify ──────────────────────────────────────────────────────────

export function signEnvelope(payloadType: string, payload: Buffer, key: KeyObject, publicKey: string): DsseEnvelope {
  const sig = sign(null, pae(payloadType, payload), key);
  return { payloadType, payload: payload.toString("base64"), signatures: [{ keyid: sshFingerprint(publicKey), sig: sig.toString("base64") }] };
}

export interface TrustedKey {
  principal: string;
  /** `ssh-ed25519 <base64>`. */
  key: string;
}

/** Who may sign: a runner key, or a CI identity that signs keyless (#4869). */
export type TrustedSigner = TrustedKey | TrustedIdentity;

export type EnvelopeVerdict =
  | { ok: true; principal: string; keyid: string; payloadType: string; payload: Buffer; keyless?: { issuer: string; subject: string; signedAt: string } }
  | { ok: false; code: "envelope-invalid" | "envelope-untrusted"; reason: string };

/**
 * Verify an envelope against `trusted`. One valid signature by a trusted
 * key, or one keyless signature by a trusted identity (#4869), is enough.
 */
export function verifyEnvelope(envelope: unknown, trusted: readonly TrustedSigner[]): EnvelopeVerdict {
  if (!isEnvelope(envelope)) return { ok: false, code: "envelope-invalid", reason: "not a DSSE envelope: it needs payloadType, payload and signatures" };
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload) return { ok: false, code: "envelope-invalid", reason: "the payload is not canonical base64" };
  const message = pae(envelope.payloadType, payload);
  const keys = trusted.filter((t): t is TrustedKey => typeof (t as TrustedKey).key === "string");
  const identities = trusted.filter((t): t is TrustedIdentity => typeof (t as TrustedIdentity).issuer === "string");
  const byId = new Map(keys.map((t) => [sshFingerprint(t.key), t]));
  let keyless: string | undefined;
  for (const s of envelope.signatures) {
    if (isKeylessSignature(s)) {
      const k = verifyKeylessSignature(message, s, identities);
      if (k.ok) return { ok: true, principal: k.principal, keyid: k.keyid, payloadType: envelope.payloadType, payload, keyless: { issuer: k.issuer, subject: k.subject, signedAt: k.signedAt } };
      keyless ??= k.reason;
      continue;
    }
    const t = byId.get(s.keyid);
    if (!t) continue;
    let good = false;
    try {
      good = verify(null, message, publicKeyObject(t.key), Buffer.from(s.sig, "base64"));
    } catch {
      good = false;
    }
    if (good) return { ok: true, principal: t.principal, keyid: s.keyid, payloadType: envelope.payloadType, payload };
  }
  const ids = envelope.signatures.map((s) => s.keyid).join(", ") || "none";
  if (keyless) return { ok: false, code: "envelope-untrusted", reason: keyless };
  return { ok: false, code: "envelope-untrusted", reason: `no signature verifies against a runner key the policy at base lists (key ids: ${ids})` };
}

function isEnvelope(v: unknown): v is DsseEnvelope {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.payloadType === "string" &&
    typeof e.payload === "string" &&
    Array.isArray(e.signatures) &&
    e.signatures.every((s) => s !== null && typeof s === "object" && typeof (s as DsseSignature).keyid === "string" && typeof (s as DsseSignature).sig === "string")
  );
}
