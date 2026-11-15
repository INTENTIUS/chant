/**
 * Finding identity (#5106). A report's `findings[].identity` and a SARIF
 * result's `partialFingerprints` name a finding by what it is, so two audit
 * runs over a base and a head can be compared without reading message text.
 *
 * The identity is a hash of the rule id, the file, the entity (the object's
 * name or address), the diagnostic's `locator` (its place inside the object:
 * kind, container index, path in the block), the fingerprint of a flagged
 * secret, and the finding's order among findings that agree on all of those.
 * `message` is not an input, so a name that only appears in the text of a
 * message (a renamed container) does not change it. Renaming the object the
 * entity names does change it.
 *
 * Not a cryptographic digest; it only has to tell findings apart.
 */

import type { AuditFinding } from "./core";
import { fingerprintSecret } from "./secrets";

/** The SARIF `partialFingerprints` key the identity is published under. */
export const IDENTITY_FINGERPRINT_KEY = "chantFindingIdentity/v1";

type IdentityInput = Pick<AuditFinding, "checkId" | "file" | "entity" | "locator" | "fingerprint" | "missing">;

function baseKey(f: IdentityInput): string {
  return [f.checkId, f.file, f.entity ?? "", f.missing ? `${f.missing.kind}@${f.missing.scope}` : "", f.locator ?? "", f.fingerprint ?? ""].join("\u0000");
}

/**
 * One identity per finding, in the order given. Findings that agree on every
 * input are told apart by their position among themselves, so the order the
 * audit emitted them in must be the order passed here.
 */
export function findingIdentities(findings: readonly IdentityInput[]): string[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const key = baseKey(f);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    // Two 64-bit halves over differently salted inputs: 32 hex characters.
    return fingerprintSecret(`${key}\u0000${n}`) + fingerprintSecret(`${n}\u0000${key}`);
  });
}
