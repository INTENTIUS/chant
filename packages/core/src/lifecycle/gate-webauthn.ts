/**
 * A gate approval signed with a passkey (#4646): a WebAuthn assertion over
 * the gate's statement, checked with node:crypto.
 *
 * A platform that collects an approval on a phone asks the browser for an
 * assertion (`navigator.credentials.get`) whose challenge is the statement's
 * digest, `base64url(SHA-256(statement))` with no padding, where the
 * statement is `gateSealPayload`'s bytes (`chant approve --statement` prints
 * them). The assertion is relayed to `chant approve --signature`, checked
 * against a passkey `.chant/trust.json` lists at base for the approver, and
 * kept on the approval's seal, so anyone can check it again offline.
 *
 * The check follows WebAuthn level 2, section 7.2, for what can be checked
 * without the relying party's state: the client data's type is
 * `webauthn.get`, its challenge is the statement's, its origin is one the
 * passkey lists and it is not cross-origin; the authenticator data's rpIdHash
 * is SHA-256 of the passkey's rpId and both the user-present and
 * user-verified flags are set; and the signature over authenticatorData ||
 * SHA-256(clientDataJSON) verifies with the passkey's public key. The
 * signature counter is not checked: a ledger line can't know the
 * authenticator's last count.
 *
 * Like `./gate-seal.ts`, this imports node:crypto and nothing else, so a
 * bundled gate decision carries it.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * A passkey `.chant/trust.json` lists for a person (#4646): the credential
 * id, its public key, the relying party it was made for, and the origins an
 * assertion may come from.
 */
export interface PasskeySigner {
  principal: string;
  /** The credential id (`rawId`), base64url with no padding. */
  id: string;
  /**
   * The credential's public key as DER SubjectPublicKeyInfo, base64url: what
   * `AuthenticatorAttestationResponse.getPublicKey()` gives. Ed25519 (EdDSA),
   * P-256 (ES256) and RSA (RS256) keys verify.
   */
  publicKey: string;
  /** The relying party id the credential is scoped to, such as `example.com`. */
  rpId: string;
  /** Origins an assertion may come from, such as `https://control.example.com`. */
  origins: string[];
}

/** A WebAuthn assertion as a browser returns it, each field base64url. */
export interface WebAuthnAssertion {
  /** The credential id. */
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** What {@link verifyWebAuthnAssertion} found. On success, `key` is the credential id. */
export type WebAuthnCheck = { ok: true; key: string } | { ok: false; reason: string };

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Whether `raw` has the shape of a {@link WebAuthnAssertion}. */
export function isWebAuthnAssertion(raw: unknown): raw is WebAuthnAssertion {
  const a = raw as Partial<Record<keyof WebAuthnAssertion, unknown>> | null;
  return (
    !!a && typeof a === "object" && !Array.isArray(a) &&
    (["id", "clientDataJSON", "authenticatorData", "signature"] as const).every((k) => typeof a[k] === "string" && B64URL.test(a[k] as string))
  );
}

/** The challenge a passkey signs for `statement`: base64url of its SHA-256, no padding. */
export function webAuthnChallenge(statement: Buffer): string {
  return createHash("sha256").update(statement).digest("base64url");
}

/** The passkey's key and the algorithm its signature is checked with, or why it can't be read. */
export function passkeyPublicKey(publicKey: string): { key: KeyObject; alg: "EdDSA" | "ES256" | "RS256" } | { problem: string } {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  } catch (err) {
    return { problem: `the public key is not a DER SubjectPublicKeyInfo: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (key.asymmetricKeyType === "ed25519") return { key, alg: "EdDSA" };
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return { key, alg: "ES256" };
  if (key.asymmetricKeyType === "rsa") return { key, alg: "RS256" };
  return { problem: `a ${key.asymmetricKeyType}${key.asymmetricKeyDetails?.namedCurve ? ` ${key.asymmetricKeyDetails.namedCurve}` : ""} key; a passkey is Ed25519, P-256 or RSA` };
}

const sameId = (a: string, b: string): boolean => a.replace(/=+$/, "") === b.replace(/=+$/, "");

/**
 * Whether `assertion` signs `statement` with one of `passkeys`, chosen by
 * credential id. Never throws.
 */
export function verifyWebAuthnAssertion(assertion: WebAuthnAssertion, statement: Buffer, passkeys: readonly PasskeySigner[]): WebAuthnCheck {
  try {
    const pk = passkeys.find((p) => sameId(p.id, assertion.id));
    if (!pk) return { ok: false, reason: `signed by passkey ${assertion.id}, which the policy at base does not list for the approver` };
    const clientData = Buffer.from(assertion.clientDataJSON, "base64url");
    let cd: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
    try {
      cd = JSON.parse(clientData.toString("utf-8"));
    } catch {
      return { ok: false, reason: "its clientDataJSON is not JSON" };
    }
    if (cd.type !== "webauthn.get") return { ok: false, reason: `its client data is a ${JSON.stringify(cd.type)} ceremony, not webauthn.get` };
    if (cd.challenge !== webAuthnChallenge(statement)) return { ok: false, reason: "its challenge is not this approval's statement digest" };
    if (typeof cd.origin !== "string" || !pk.origins.includes(cd.origin)) {
      return { ok: false, reason: `it comes from origin ${JSON.stringify(cd.origin)}, and the passkey allows ${pk.origins.join(", ")}` };
    }
    if (cd.crossOrigin === true) return { ok: false, reason: "it was made in a cross-origin frame" };
    const authData = Buffer.from(assertion.authenticatorData, "base64url");
    if (authData.length < 37) return { ok: false, reason: "its authenticatorData is shorter than 37 bytes" };
    if (!authData.subarray(0, 32).equals(createHash("sha256").update(pk.rpId, "utf-8").digest())) {
      return { ok: false, reason: `its rpIdHash is not SHA-256 of ${pk.rpId}` };
    }
    const flags = authData[32]!;
    if (!(flags & 0x01)) return { ok: false, reason: "the user-present flag is unset" };
    if (!(flags & 0x04)) return { ok: false, reason: "the user-verified flag is unset" };
    const key = passkeyPublicKey(pk.publicKey);
    if ("problem" in key) return { ok: false, reason: `passkey ${pk.id}: ${key.problem}` };
    const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
    const signature = Buffer.from(assertion.signature, "base64url");
    // ES256 signatures are ASN.1 DER, node's default for an EC key.
    const ok = verify(key.alg === "EdDSA" ? null : "sha256", signed, key.key, signature);
    return ok ? { ok: true, key: pk.id } : { ok: false, reason: "the signature does not match the signed fields" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
