import type { PostSynthCheck, PostSynthDiagnostic } from "./post-synth";
import { isEffectReceipt } from "../effect-receipt";
import { isSensitiveKey } from "../deep-observation";
import { isResourceDeclarable } from "../declarable";

/**
 * COR023: Receipt Materializes Into a Plain Store (#1833, epic #1703)
 *
 * A receipt's materialization target must be a plain store — never a
 * SecureString, a Secret, or any secret-capable kind. A receipt value is a
 * witness (an existence marker or a `sha256:` digest,
 * ../effect-receipt.ts), not a secret: parking it in a secret-capable store
 * invites masking, rotation, and access-control semantics that defeat the
 * observe-and-compare loop the receipt exists for, and quietly teaches
 * readers that the value is sensitive when it must never be.
 *
 * This is the honest core half of the guard. Core recognizes receipts
 * lexicon-independently through the marker (#1831) but cannot know what any
 * lexicon's kinds mean, so it checks the two signals it does have, both
 * reusing the secret-kind knowledge core already carries
 * (SENSITIVE_KEY_PATTERNS, ../deep-observation.ts):
 *
 *  - the materialized `entityType` names a secret-capable kind
 *    (`K8s::Core::Secret`, `AWS::SecretsManager::Secret`, ...);
 *  - the declared props select a secret-capable variant of an otherwise
 *    plain kind (a `Type`/`Kind` prop whose value matches secret/secure —
 *    SSM's `Type: "SecureString"` is the canonical case).
 *
 * The concrete per-kind enforcement is each materialization row's job — the
 * aws row (#1835) pins SSM to plain `String` at the source.
 */

/** Prop names that select a store variant. */
const VARIANT_PROP = /^(type|kind)$/i;
/** Variant values that make the store secret-capable. */
const SECRET_VARIANT = /secret|secure/i;

export const RECEIPT_PLAIN_STORE_CHECK_ID = "COR023";

const receiptPlainStoreCheck: PostSynthCheck = {
  id: RECEIPT_PLAIN_STORE_CHECK_ID,
  description:
    "An effect receipt's materialization target must be a plain store — never a secret-capable kind or variant",
  check(ctx) {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [name, entity] of ctx.entities) {
      if (!isEffectReceipt(entity)) continue;

      if (isSensitiveKey(entity.entityType)) {
        diagnostics.push({
          checkId: RECEIPT_PLAIN_STORE_CHECK_ID,
          severity: "error",
          entity: name,
          lexicon: entity.lexicon,
          message:
            `Effect receipt "${name}" materializes into secret-capable kind "${entity.entityType}" — ` +
            `a receipt's target must be a plain store. The receipt value is a witness ` +
            `(an existence marker or a sha256 digest), not a secret; a secret-capable store adds ` +
            `masking and rotation semantics that defeat the receipt's observe-and-compare loop.`,
        });
        continue;
      }

      if (isResourceDeclarable(entity) && typeof entity.props === "object" && entity.props !== null) {
        for (const [key, value] of Object.entries(entity.props as Record<string, unknown>)) {
          if (VARIANT_PROP.test(key) && typeof value === "string" && SECRET_VARIANT.test(value)) {
            diagnostics.push({
              checkId: RECEIPT_PLAIN_STORE_CHECK_ID,
              severity: "error",
              entity: name,
              lexicon: entity.lexicon,
              message:
                `Effect receipt "${name}" (${entity.entityType}) declares ${key}: "${value}" — ` +
                `a secret-capable store variant. A receipt's target must be a plain store; ` +
                `use the plain variant (e.g. SSM Type: "String") so the witness value stays ` +
                `readable to the observe-and-compare loop.`,
            });
          }
        }
      }
    }
    return diagnostics;
  },
};

/**
 * Core's own post-synth checks over effect receipts, run by `chant build`
 * over the full build result (plugin checks are lexicon-scoped; receipts are
 * recognized by marker, so this set is deliberately not).
 */
export function coreReceiptChecks(): PostSynthCheck[] {
  return [receiptPlainStoreCheck];
}
