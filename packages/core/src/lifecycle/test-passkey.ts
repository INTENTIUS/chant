/**
 * Passkeys for tests (#4646): a key pair listed as `.chant/trust.json` lists
 * one, and assertions built by hand the way an authenticator builds them.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { webAuthnChallenge, type PasskeySigner, type WebAuthnAssertion } from "./gate-webauthn";

export const RP = "example.com";
export const ORIGIN = "https://control.example.com";

export interface Passkey {
  signer: PasskeySigner;
  privateKey: KeyObject;
  alg: "EdDSA" | "ES256";
}

/** A passkey for `principal`: a fresh key pair, listed as trust.json lists one. */
export function passkey(principal: string, id: string, alg: "EdDSA" | "ES256" = "EdDSA"): Passkey {
  const { publicKey, privateKey } = alg === "EdDSA" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    signer: { principal, id, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), rpId: RP, origins: [ORIGIN] },
    privateKey,
    alg,
  };
}

/** What an authenticator would return for `statement`, with each part open to change for a refusal. */
export function assert(
  pk: Passkey,
  statement: Buffer,
  over: { type?: string; challenge?: string; origin?: string; rpId?: string; flags?: number; crossOrigin?: boolean } = {},
): WebAuthnAssertion {
  const clientData = Buffer.from(
    JSON.stringify({
      type: over.type ?? "webauthn.get",
      challenge: over.challenge ?? webAuthnChallenge(statement),
      origin: over.origin ?? ORIGIN,
      ...(over.crossOrigin !== undefined ? { crossOrigin: over.crossOrigin } : {}),
    }),
  );
  const authData = Buffer.concat([
    createHash("sha256").update(over.rpId ?? RP).digest(),
    Buffer.from([over.flags ?? 0x05]),
    Buffer.from([0, 0, 0, 7]),
  ]);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  const signature = sign(pk.alg === "EdDSA" ? null : "sha256", signed, pk.privateKey);
  return {
    id: pk.signer.id,
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}
