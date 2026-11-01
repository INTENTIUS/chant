/**
 * A gate approval's statement, for a signature made outside chant (#4646).
 *
 * `chant approve --sign` signs `gateSealPayload`'s bytes with an ssh key on
 * the machine running chant. A platform that collects the approval somewhere
 * else (a phone with a passkey, a device key on another machine) needs the
 * same bytes before anything is recorded: `chant approve <op> <gate>
 * --statement` prints them as a `chant-gate-statement/v1` document
 * (`../gate-statement.schema.json`), with the time fixed so the signature and
 * the approval that records it cover the same line. The platform has the
 * person sign them and hands the signature to `chant approve --signature`,
 * with the same `--actor`, `--relayed-by` and `--at`.
 */

import { createHash } from "node:crypto";
import { NEXT_RELEASE } from "../release-floors";
import { GATE_SEAL_NAMESPACE, gateSealPayload, gateSealVersion, isWebAuthnAssertion, webAuthnChallenge, type SealedGateApproval, type WebAuthnAssertion } from "./gate-seal";

/**
 * The first chant that prints a gate's statement, records an approval
 * signed elsewhere (`chant approve --signature`), reads `passkeys` in
 * `.chant/trust.json` and verifies a seal of kind `webauthn` (#4646). An
 * older chant reads a trust.json with `passkeys` as invalid, which turns
 * attestation off, and counts no passkey seal toward a gate.
 */
export const GATE_EXTERNAL_SIGNATURE_FLOOR = NEXT_RELEASE;

export const GATE_STATEMENT_SCHEMA = "chant-gate-statement/v1";

/** The `$id` of `../gate-statement.schema.json`, which the package exports as `@intentius/chant/gate-statement.schema.json`. */
export const GATE_STATEMENT_SCHEMA_ID = "https://intentius.io/chant/schemas/gate-statement/v1/gate-statement.schema.json";

/** What `chant approve <op> <gate> --statement` prints. */
export interface GateStatement {
  schema: typeof GATE_STATEMENT_SCHEMA;
  chantVersion: string;
  op: string;
  gate: string;
  environment: string | null;
  planDigest: string | null;
  resolvedBy: string;
  relayedBy: string | null;
  timestamp: string;
  checkpointDigest: string | null;
  /** 1, or 2 when the statement signs a checkpoint digest. */
  sealVersion: 1 | 2;
  /** The ssh signature namespace an ssh key signs the statement in. */
  namespace: typeof GATE_SEAL_NAMESPACE;
  /** The statement's UTF-8 text, LF-joined with no final newline. */
  text: string;
  /** The same bytes, base64. */
  statement: string;
  /** `sha256:` and the bytes' SHA-256 in hex. */
  digest: string;
  /** The WebAuthn challenge: base64url of the bytes' SHA-256, no padding. */
  challenge: string;
}

/** The statement of approval `a`, as `chant approve --statement` prints it. */
export function gateStatement(a: SealedGateApproval, chantVersion: string): GateStatement {
  const bytes = gateSealPayload(a);
  return {
    schema: GATE_STATEMENT_SCHEMA,
    chantVersion,
    op: a.op,
    gate: a.gate,
    environment: a.environment ?? null,
    planDigest: a.planDigest ?? null,
    resolvedBy: a.resolvedBy,
    relayedBy: a.relayedBy ?? null,
    timestamp: a.timestamp,
    checkpointDigest: a.checkpointDigest ?? null,
    sealVersion: gateSealVersion(a),
    namespace: GATE_SEAL_NAMESPACE,
    text: bytes.toString("utf-8"),
    statement: bytes.toString("base64"),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    challenge: webAuthnChallenge(bytes),
  };
}

/** A signature `chant approve --signature` was handed. */
export type ExternalSignature = { kind: "ssh"; signature: string } | { kind: "webauthn"; assertion: WebAuthnAssertion };

/**
 * Read what `--signature` names: an armored ssh signature, or a WebAuthn
 * assertion as JSON, either `{ id, clientDataJSON, authenticatorData,
 * signature }` or a `PublicKeyCredential`'s `toJSON()` with those three
 * under `response`. Returns a problem when it is neither.
 */
export function readExternalSignature(text: string): ExternalSignature | { problem: string } {
  const armored = /-----BEGIN SSH SIGNATURE-----[^-]*-----END SSH SIGNATURE-----/.exec(text);
  if (armored) return { kind: "ssh", signature: `${armored[0]}\n` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "it is neither an armored ssh signature (-----BEGIN SSH SIGNATURE-----) nor a WebAuthn assertion in JSON" };
  }
  const o = raw as { id?: unknown; response?: Record<string, unknown> } | null;
  const flat = o && typeof o === "object" && o.response && typeof o.response === "object" ? { id: o.id, ...o.response } : raw;
  if (!isWebAuthnAssertion(flat)) {
    return { problem: "a WebAuthn assertion needs id, clientDataJSON, authenticatorData and signature, each base64url" };
  }
  const { id, clientDataJSON, authenticatorData, signature } = flat;
  return { kind: "webauthn", assertion: { id, clientDataJSON, authenticatorData, signature } };
}
