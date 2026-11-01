/**
 * #4646: a passkey's assertion over a gate's statement, checked with
 * node:crypto. Each assertion is built by hand the way an authenticator
 * builds one: client data, authenticator data, and a signature over
 * authenticatorData || SHA-256(clientDataJSON).
 */

import { describe, expect, test } from "vitest";
import { gateSealPayload, gateSealRefusal, type GateSigners, type SealedGateApproval } from "./gate-seal";
import { verifyWebAuthnAssertion, webAuthnChallenge, type WebAuthnAssertion } from "./gate-webauthn";
import { assert, passkey } from "./test-passkey";
import { readExternalSignature } from "./gate-statement";

const approval: SealedGateApproval = {
  op: "deploy",
  gate: "ship",
  environment: "prod",
  planDigest: `sha256:${"a".repeat(64)}`,
  resolvedBy: "github:erin",
  timestamp: "2026-11-01T10:00:00.000Z",
};
const statement = gateSealPayload(approval);

describe("a passkey's assertion over a gate statement (#4646)", () => {
  test.each(["EdDSA", "ES256"] as const)("verifies with an %s passkey", (alg) => {
    const pk = passkey("github:erin", "cred-erin", alg);
    expect(verifyWebAuthnAssertion(assert(pk, statement), statement, [pk.signer])).toEqual({ ok: true, key: "cred-erin" });
  });

  test("refuses what WebAuthn level 2 refuses", () => {
    const pk = passkey("github:erin", "cred-erin");
    const why = (a: WebAuthnAssertion, over: Buffer = statement) => {
      const r = verifyWebAuthnAssertion(a, over, [pk.signer]);
      return r.ok ? null : r.reason;
    };
    expect(why(assert(pk, statement, { type: "webauthn.create" }))).toMatch(/not webauthn\.get/);
    expect(why(assert(pk, statement, { challenge: webAuthnChallenge(Buffer.from("other")) }))).toMatch(/challenge/);
    expect(why(assert(pk, statement, { origin: "https://evil.example" }))).toMatch(/origin "https:\/\/evil\.example"/);
    expect(why(assert(pk, statement, { crossOrigin: true }))).toMatch(/cross-origin/);
    expect(why(assert(pk, statement, { rpId: "evil.example" }))).toMatch(/rpIdHash/);
    expect(why(assert(pk, statement, { flags: 0x01 }))).toMatch(/user-verified/);
    expect(why(assert(pk, statement, { flags: 0x04 }))).toMatch(/user-present/);
    // A different plan digest is a different statement.
    expect(why(assert(pk, statement), gateSealPayload({ ...approval, planDigest: `sha256:${"b".repeat(64)}` }))).toMatch(/challenge/);
    // Another key under the listed id.
    const other = passkey("github:erin", "cred-erin");
    expect(why(assert(other, statement))).toMatch(/does not match/);
    // A credential nobody listed.
    expect(why({ ...assert(pk, statement), id: "cred-unknown" })).toMatch(/does not list/);
    // A signature over other bytes.
    const a = assert(pk, statement);
    expect(why({ ...a, authenticatorData: Buffer.concat([Buffer.from(a.authenticatorData, "base64url"), Buffer.from([1])]).toString("base64url") })).toMatch(/does not match/);
  });

  test("a sealed gate counts the passkey's seal for its approver only", () => {
    const pk = passkey("github:erin", "cred-erin", "ES256");
    const a = assert(pk, statement);
    const seal = { kind: "webauthn", signer: "github:erin", key: a.id, signature: a.signature, clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData };
    const signers: GateSigners = { base: null, signersPath: ".chant/allowed_signers", active: true, signers: [], passkeys: [pk.signer], problems: [] };
    expect(gateSealRefusal(signers, { ...approval, seal })).toBeNull();
    expect(gateSealRefusal({ ...signers, passkeys: [] }, { ...approval, seal })).toMatch(/has no passkey in \.chant\/trust\.json at base/);
    expect(gateSealRefusal({ ...signers, passkeys: [{ ...pk.signer, principal: "github:frank" }] }, { ...approval, seal })).toMatch(/has no passkey/);
    expect(gateSealRefusal(signers, { ...approval, planDigest: `sha256:${"c".repeat(64)}`, seal })).toMatch(/challenge/);
    expect(gateSealRefusal(signers, { ...approval, seal: { ...seal, kind: "x509" } })).toMatch(/kind "x509"/);
  });

  test("--signature reads an ssh signature, an assertion, or a PublicKeyCredential's JSON", () => {
    const pk = passkey("github:erin", "cred-erin");
    const a = assert(pk, statement);
    expect(readExternalSignature(JSON.stringify(a))).toEqual({ kind: "webauthn", assertion: a });
    const { id, ...response } = a;
    expect(readExternalSignature(JSON.stringify({ id, rawId: id, type: "public-key", response: { ...response, userHandle: null } }))).toEqual({ kind: "webauthn", assertion: a });
    expect(readExternalSignature("-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n")).toMatchObject({ kind: "ssh" });
    expect(readExternalSignature("{}")).toHaveProperty("problem");
    expect(readExternalSignature("nonsense")).toHaveProperty("problem");
  });
});
