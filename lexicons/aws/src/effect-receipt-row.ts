/**
 * The aws effect-receipt materialization row (#1835, epic #1703): an effect
 * receipt stored as an `AWS::SSM::Parameter`, plain `String`, at
 * `/chant-receipts/<stack>/<env>/<effect>`.
 *
 * Core's `EffectReceipt` factory (#1831) declares a receipt under the `chant`
 * pseudo-lexicon, which no serializer claims — the designed shape until a
 * lexicon materializes it. This module is that materialization for aws: the
 * {@link EffectReceipt} factory here produces the same declaration shape but
 * under `lexicon: "aws"`, so the build partitions it to the aws serializer,
 * #1832's write-exclusion seam withholds it from the apply-bound entity set,
 * and the serializer renders it for visibility through
 * `SerializeContext.receipts` (see ./serializer.ts).
 *
 * Path identity (epic decision 4): the parameter name derives from the SAME
 * ownership-block fields that stamp markers — `ownership.stack` and an
 * explicit `ownership.env` — plus the receipt's `effect`. One derivation,
 * {@link receiptParameterName}, shared by the serializer (the rendered row),
 * the receipt store (../receipt-store.ts — what `receiptRead`/`receiptWrite`
 * actually touch), and the observation leg (plan's live read). No env, no
 * path: the callers error rather than guessing a segment.
 *
 * Plain store (epic decision 7, #1833's COR023): the parameter type is pinned
 * to `String` at the source — the factory does not take a type, and the
 * declared `props.Type` is the literal `"String"`. A receipt value is a
 * witness (an existence marker or a `sha256:` digest), never a secret; a
 * `SecureString` invites masking and rotation semantics that defeat the
 * observe-and-compare loop, and the lint guard fails it.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import {
  EffectReceipt as CoreEffectReceipt,
  EFFECT_RECEIPT_MARKER,
  type EffectReceiptFlavor,
  type EffectReceiptOptions,
} from "@intentius/chant/effect-receipt";

/** The entityType of the aws materialization row — the real resource kind the
 * receipt is stored as, which is what lint's plain-store guard checks. */
export const AWS_EFFECT_RECEIPT_ENTITY_TYPE = "AWS::SSM::Parameter";

/** Template-level `Metadata` key the serializer renders receipt rows under.
 * Beside `chant:ownership` (./ownership.ts) and like it deliberately outside
 * `Resources` — the applier writes from `Resources`, and a receipt must never
 * enter the apply-bound document (#1832; the `effect()` step is the sole
 * writer, epic decision 3). */
export const EFFECT_RECEIPTS_METADATA_KEY = "chant:effect-receipts";

/** Every receipt parameter lives under this prefix, so read-only IAM can be
 * scoped to `arn:…:parameter/chant-receipts/*` and nothing else. */
export const RECEIPT_PATH_PREFIX = "/chant-receipts";

/**
 * The rendered `Value` of a hash-flavor receipt that still carries reference
 * inputs at synthesis. References resolve at plan and at run, never at
 * synthesis (epic decision 5) — so the row carries this note instead of a
 * digest hashed over placeholders.
 */
export const RECEIPT_UNRESOLVED_VALUE_NOTE =
  "unresolved at synthesis — reference inputs; the expectation resolves at plan and at run (chant #1703, decision 5)";

/** One path segment of the receipt parameter name. SSM hierarchical names are
 * `/`-separated `[\w.-]+` segments, and the identity must stay one segment per
 * field — a `/` inside a stack name would silently deepen the hierarchy. */
const PATH_SEGMENT = /^[\w.-]+$/;

function checkSegment(field: string, value: string): string {
  if (!PATH_SEGMENT.test(value)) {
    throw new Error(
      `receipt path: ${field} "${value}" is not a valid SSM path segment — ` +
        `use only letters, digits, ".", "_", "-" (the segment becomes one level of ` +
        `${RECEIPT_PATH_PREFIX}/<stack>/<env>/<effect>)`,
    );
  }
  return value;
}

/**
 * The SSM parameter name of one effect's receipt:
 * `/chant-receipts/<stack>/<env>/<effect>`, from the resolved ownership
 * marker fields (epic decision 4). The single source of the path identity —
 * the serializer's rendered row, the receipt store's reads and writes, and
 * the observation leg all call this.
 */
export function receiptParameterName(stack: string, env: string, effect: string): string {
  return `${RECEIPT_PATH_PREFIX}/${checkSegment("stack", stack)}/${checkSegment("env", env)}/${checkSegment("effect", effect)}`;
}

/**
 * An aws-materialized effect receipt: core's declaration shape (so
 * `isEffectReceipt`, `effect(...)`, lint, and the plan engine all recognize it
 * through the marker), under the aws lexicon and the real resource kind, with
 * the store variant pinned plain.
 */
export interface AwsEffectReceiptDeclaration extends Declarable {
  readonly [EFFECT_RECEIPT_MARKER]: true;
  readonly lexicon: "aws";
  readonly entityType: typeof AWS_EFFECT_RECEIPT_ENTITY_TYPE;
  /** The receipt's own name (the export-level identity of the witness). */
  readonly name: string;
  /** The effect this receipt witnesses — the path's final segment. */
  readonly effect: string;
  /** How the receipt is compared: mere presence, or a digest of the inputs. */
  readonly flavor: EffectReceiptFlavor;
  /** The effect's inputs as recorded at synthesis (references as placeholders). */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** The declared parameter variant — pinned `String` at the source, which is
   * the concrete half of #1833's plain-store guard. */
  readonly props: { readonly Type: "String" };
}

/**
 * Declare an aws-materialized effect receipt. Same signature and semantics as
 * core's `EffectReceipt` (#1831) — the options are validated and frozen by the
 * core factory — but the declaration lands in the aws partition, so the aws
 * serializer renders the `AWS::SSM::Parameter` row and the receipt store
 * (../receipt-store.ts) is its writer. Pass the returned const straight to the
 * `effect(...)` op step.
 */
export function EffectReceipt(name: string, options: EffectReceiptOptions): AwsEffectReceiptDeclaration {
  // Fail at declaration, not at serialize: the effect is the path's final
  // segment, and a name that cannot become a segment has no receipt address.
  if (typeof options?.effect === "string" && options.effect.length > 0) {
    checkSegment("effect", options.effect);
  }
  const core = CoreEffectReceipt(name, options);
  const decl: AwsEffectReceiptDeclaration = {
    [DECLARABLE_MARKER]: true,
    [EFFECT_RECEIPT_MARKER]: true,
    lexicon: "aws",
    entityType: AWS_EFFECT_RECEIPT_ENTITY_TYPE,
    name: core.name,
    effect: core.effect,
    flavor: core.flavor,
    // The same frozen structure the core factory built — intrinsic inputs stay
    // live so discovery can stamp logical names onto attr-refs.
    inputs: core.inputs,
    props: Object.freeze({ Type: "String" as const }),
  };
  // Declared fields immutable, object extensible for discovery's own
  // symbol-keyed metadata — the same lock the core factory applies.
  for (const key of Object.keys(decl)) {
    Object.defineProperty(decl, key, { writable: false, configurable: false });
  }
  return decl;
}
