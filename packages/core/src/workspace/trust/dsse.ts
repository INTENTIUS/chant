/**
 * DSSE envelopes (https://github.com/secure-systems-lab/dsse, v1) signed with
 * runner keys (#2553): Ed25519, or ECDSA P-256 with SHA-256 (#5470).
 *
 * The signature covers the pre-authentication encoding (PAE) of the payload
 * type and the payload, never the payload alone, so an envelope cannot be
 * replayed under another type. Everything here runs offline: verifying needs
 * the envelope and the public key, nothing else.
 *
 * Public keys are written the way ssh writes them (`ssh-ed25519 AAAA...`,
 * `ecdsa-sha2-nistp256 AAAA...`), so
 * the runner keys in `.chant/trust.json` read like the signers file beside
 * them, and a key id is the key's ssh fingerprint (`SHA256:...`).
 *
 * A signature can instead be keyless (#4869, ./keyless.ts): it carries the
 * short-lived certificate of a CI job's OIDC identity and a timestamp, and
 * verifies against an identity the policy lists rather than a key. The
 * identity brings its own verifier, so this file, which bundles such as the
 * runner-start verifier carry, holds no certificate code.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { NEXT_RELEASE } from "../../release-floors";

export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** The first chant whose runner keys may be ECDSA P-256 as well as Ed25519 (#5470): `ecdsa-sha2-nistp256` lines under `runners` and `local.keys` in `.chant/trust.json`, envelopes signed with ECDSA and SHA-256, `chant ci serve|run --setup-key --key-type ecdsa-p256`, and the crypto module in doctor output and publish records. An older chant reads a trust config with such a line as invalid. */
export const ECDSA_RUNNER_KEY_FLOOR = NEXT_RELEASE;

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

// ── Runner public keys, as ssh writes them ──────────────────────────────────

/**
 * The kinds a runner key may be (#5470): Ed25519, and ECDSA on P-256 with
 * SHA-256 for a module that approves ECDSA and not EdDSA. Each is listed in
 * `.chant/trust.json` as the ssh line of its type.
 */
export const RUNNER_KEY_KINDS = ["ed25519", "ecdsa-p256"] as const;
export type RunnerKeyKind = (typeof RUNNER_KEY_KINDS)[number];

/** The ssh key type of each kind. */
export const RUNNER_KEY_SSH_TYPES: Record<RunnerKeyKind, string> = { ed25519: "ssh-ed25519", "ecdsa-p256": "ecdsa-sha2-nistp256" };

export { RUNNER_KEY_LINE } from "./trust-files";

/** What a runner key may be, for messages. */
export const RUNNER_KEY_WORDS = "an Ed25519 or ECDSA P-256 private key in PEM";

function sshString(buf: Buffer, at: number): { value: Buffer; next: number } {
  if (at + 4 > buf.length) throw new Error("truncated key");
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) throw new Error("truncated key");
  return { value: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

const sshPart = (b: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};

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
  return `ssh-ed25519 ${Buffer.concat([sshPart(Buffer.from("ssh-ed25519")), sshPart(raw)]).toString("base64")}`;
}

/** The 65-byte uncompressed point (`04 || x || y`) of an `ecdsa-sha2-nistp256 <base64>` public key. */
export function p256FromSsh(line: string): Buffer {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== "ecdsa-sha2-nistp256" || !b64) throw new Error("not an ecdsa-sha2-nistp256 public key");
  const blob = Buffer.from(b64, "base64");
  const t = sshString(blob, 0);
  if (t.value.toString("utf8") !== "ecdsa-sha2-nistp256") throw new Error("the key blob is not ecdsa-sha2-nistp256");
  const c = sshString(blob, t.next);
  if (c.value.toString("utf8") !== "nistp256") throw new Error("the key blob names no nistp256 curve");
  const q = sshString(blob, c.next);
  if (q.value.length !== 65 || q.value[0] !== 0x04 || q.next !== blob.length) throw new Error("not an uncompressed 65-byte P-256 point");
  return Buffer.from(q.value);
}

/** An `ecdsa-sha2-nistp256 <base64>` line for a 65-byte uncompressed P-256 point. */
export function sshFromP256(point: Buffer): string {
  const type = Buffer.from("ecdsa-sha2-nistp256");
  return `ecdsa-sha2-nistp256 ${Buffer.concat([sshPart(type), sshPart(Buffer.from("nistp256")), sshPart(point)]).toString("base64")}`;
}

/** The kind of a runner public key line, or why it is none. */
export function runnerKeyKindOf(line: string): RunnerKeyKind {
  const type = line.trim().split(/\s+/)[0];
  if (type === "ssh-ed25519") return "ed25519";
  if (type === "ecdsa-sha2-nistp256") return "ecdsa-p256";
  throw new Error(`runner keys are ssh-ed25519 or ecdsa-sha2-nistp256, not ${type || "blank"}`);
}

/** The ssh fingerprint of a public key line: `SHA256:` and unpadded base64. */
export function sshFingerprint(line: string): string {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The public key a runner key line names, checked as it is parsed. */
export function runnerPublicKeyObject(line: string): KeyObject {
  if (runnerKeyKindOf(line) === "ed25519") return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: ed25519FromSsh(line).toString("base64url") }, format: "jwk" });
  const q = p256FromSsh(line);
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: q.subarray(1, 33).toString("base64url"), y: q.subarray(33).toString("base64url") }, format: "jwk" });
}

/** The ssh line of a public (or private) Ed25519 or P-256 key, or why it is neither. */
export function sshFromKeyObject(key: KeyObject): { kind: RunnerKeyKind; line: string } {
  const pub = key.type === "public" ? key : createPublicKey(key);
  if (pub.asymmetricKeyType === "ed25519") {
    const jwk = pub.export({ format: "jwk" }) as { x: string };
    return { kind: "ed25519", line: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
  }
  if (pub.asymmetricKeyType === "ec") {
    const jwk = pub.export({ format: "jwk" }) as { crv?: string; x: string; y: string };
    if (jwk.crv !== "P-256") throw new Error(`runner keys on ECDSA use P-256, not ${jwk.crv ?? "an unnamed curve"}`);
    return { kind: "ecdsa-p256", line: sshFromP256(Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])) };
  }
  throw new Error(`runner keys are Ed25519 or ECDSA P-256, not ${pub.asymmetricKeyType}`);
}

/** A private runner key from PEM (PKCS#8, or SEC1 for P-256), its kind, and its public half as an ssh line. */
export function loadRunnerKey(pem: string): { key: KeyObject; publicKey: string; kind: RunnerKeyKind } {
  const key = createPrivateKey(pem);
  const { kind, line } = sshFromKeyObject(key);
  return { key, publicKey: line, kind };
}

/** The digest `sign`/`verify` take for a key: none for Ed25519, which hashes inside, SHA-256 for P-256. */
const digestFor = (key: KeyObject): string | null => (key.asymmetricKeyType === "ed25519" ? null : "sha256");

// ── Sign and verify ──────────────────────────────────────────────────────────

/**
 * Sign the PAE of the payload. An Ed25519 key signs it as Ed25519 does; a
 * P-256 key signs it as ECDSA with SHA-256, the signature DER-encoded, as
 * DSSE signers on ECDSA do.
 */
export function signEnvelope(payloadType: string, payload: Buffer, key: KeyObject, publicKey: string): DsseEnvelope {
  const sig = sign(digestFor(key), pae(payloadType, payload), key);
  return { payloadType, payload: payload.toString("base64"), signatures: [{ keyid: sshFingerprint(publicKey), sig: sig.toString("base64") }] };
}

export interface TrustedKey {
  principal: string;
  /** `ssh-ed25519 <base64>` or `ecdsa-sha2-nistp256 <base64>`. */
  key: string;
}

/** What a keyless identity says of one signature (#4869). `named`: the certificate is this identity's, and something else failed. */
export type KeylessCheck = { ok: true; keyid: string; issuer: string; subject: string; signedAt: string } | { ok: false; named: boolean; reason: string };

/** A CI identity that signs keyless (#4869), as the policy at base reads it, with the verifier for its trusted root. */
export interface TrustedIdentity {
  principal: string;
  issuer: string;
  verifyKeyless(message: Buffer, signature: DsseSignature): KeylessCheck;
}

/** Who may sign: a runner key, or a CI identity that signs keyless (#4869). */
export type TrustedSigner = TrustedKey | TrustedIdentity;

const isKeyless = (s: DsseSignature): boolean => Array.isArray(s.certificates) && typeof s.timestamp === "string";

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
  const identities = trusted.filter((t): t is TrustedIdentity => typeof (t as TrustedIdentity).verifyKeyless === "function");
  const byId = new Map(keys.map((t) => [sshFingerprint(t.key), t]));
  let keyless: string | undefined;
  for (const s of envelope.signatures) {
    if (isKeyless(s)) {
      if (identities.length === 0) keyless ??= "the signature is keyless, and the policy at base lists no keyless identity";
      let named: string | undefined;
      for (const id of identities) {
        const k = id.verifyKeyless(message, s);
        if (k.ok) return { ok: true, principal: id.principal, keyid: k.keyid, payloadType: envelope.payloadType, payload, keyless: { issuer: k.issuer, subject: k.subject, signedAt: k.signedAt } };
        if (k.named) named ??= k.reason;
        else keyless ??= k.reason;
      }
      if (named) keyless = named;
      continue;
    }
    const t = byId.get(s.keyid);
    if (!t) continue;
    let good = false;
    try {
      const pub = runnerPublicKeyObject(t.key);
      good = verify(digestFor(pub), message, pub, Buffer.from(s.sig, "base64"));
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
