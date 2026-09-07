/**
 * The k8s effect-receipt materialization row (#2074, epic #1703): an effect
 * receipt stored as a core `ConfigMap`, named
 * `chant-receipt.<stack>.<env>.<effect>`, holding the expectation under
 * `data.expectation`.
 *
 * Core's `EffectReceipt` factory (#1831) declares a receipt under the `chant`
 * pseudo-lexicon, which no serializer claims. This module is the k8s
 * materialization, built to the same shape as the aws SSM row (#1835,
 * `lexicons/aws/src/effect-receipt-row.ts`): the {@link EffectReceipt} factory
 * here produces core's declaration under `lexicon: "k8s"`, so the build
 * partitions it to the k8s serializer, #1832's write-exclusion seam withholds
 * it from the apply-bound entity set, and the serializer renders it for
 * visibility through `SerializeContext.receipts` (see ./serializer.ts).
 *
 * Where the aws row parks its rendered rows in the CloudFormation template's
 * `Metadata` (deliberately outside `Resources`, the section an applier writes
 * from), this row parks them in a YAML COMMENT at the end of the manifest
 * stream. Kubernetes YAML has no metadata channel outside the documents
 * themselves, and a document is exactly what an applier applies: `loadAll`
 * yields no object for a comment, so the receipt block is structurally
 * unreachable from `applyManifest` while still riding the one build output the
 * observation leg is handed. See {@link EFFECT_RECEIPTS_COMMENT_MARKER}.
 *
 * ## Name and namespace
 *
 * Path identity (epic decision 4): the ConfigMap name derives from the SAME
 * ownership-block fields that stamp markers, `ownership.stack` and an explicit
 * `ownership.env`, plus the receipt's `effect`. The separator is `.`, which no
 * segment may contain, so `stack=a-b env=c` and `stack=a env=b-c` cannot
 * produce the same name. The result is a valid RFC 1123 DNS subdomain, which
 * is what a ConfigMap name has to be.
 *
 * The namespace is the project's `k8s.receipts.namespace`, and `default` when
 * the project sets none, which is where every other namespace-less k8s read
 * and write in this lexicon already lands. It is never invented from the stack
 * or the environment: a namespace chant guessed would be a namespace chant has
 * to create, and the receipt row creates nothing but the receipt.
 *
 * ## Ownership, and why the prune leaves it alone
 *
 * Every receipt ConfigMap carries chant's ownership marker labels plus
 * {@link RECEIPT_LABEL_KEY}. The marker is what makes `chant kube get` and the
 * observation classify it as chant's rather than foreign. The receipt label is
 * what keeps `delete: "owned-only"` from pruning it: the receipt is owned and
 * is never in any apply set (the effect step is its sole writer), which is the
 * exact shape the owned-only sweep deletes. `pruneOrphans`
 * (./op/activities/kubectl.ts) reports it `retained` instead, the same
 * treatment a generated-once Secret gets (./secret-labels.ts) and for the same
 * reason: destroying it silently converts at-least-once into a re-run nobody
 * asked for, or worse, into never.
 *
 * Plain store (#1833's COR023): a ConfigMap is the plain half of the
 * ConfigMap/Secret pair, and the entityType alone is what the guard reads. A
 * receipt value is a witness (an existence marker or a `sha256:` digest),
 * never a secret; materializing one into a `K8s::Core::Secret` fails COR023.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import {
  EffectReceipt as CoreEffectReceipt,
  EFFECT_RECEIPT_MARKER,
  type EffectReceiptFlavor,
  type EffectReceiptOptions,
} from "@intentius/chant/effect-receipt";

/** The entityType of the k8s materialization row, the real resource kind the
 * receipt is stored as, which is what lint's plain-store guard checks. */
export const K8S_EFFECT_RECEIPT_ENTITY_TYPE = "K8s::Core::ConfigMap";

/** apiVersion/kind of the materialized row, for the client reads and writes. */
export const RECEIPT_CONFIGMAP_REF = { apiVersion: "v1", kind: "ConfigMap" } as const;

/**
 * The line prefix the serializer renders receipt rows behind, and the
 * observation leg reads them back from. A YAML comment: an applier's `loadAll`
 * produces no document for it, so a receipt can never enter an apply set, and
 * `kubectl apply -f` ignores it exactly as it ignores every other comment.
 * The remainder of the line is one JSON object keyed by entity name.
 */
export const EFFECT_RECEIPTS_COMMENT_MARKER = "# chant:effect-receipts ";

/** First segment of every receipt ConfigMap name. */
export const RECEIPT_NAME_PREFIX = "chant-receipt";

/** The `data` key the expectation is stored under. One key, the same single
 * value the aws row puts in the SSM parameter's `Value`. */
export const RECEIPT_DATA_KEY = "expectation";

/** The label a live receipt ConfigMap carries, valued with the effect it
 * witnesses. Recognition for the observation leg and, more importantly, the
 * exclusion the owned-only prune keys on. */
export const RECEIPT_LABEL_KEY = "chant.intentius.io/effect-receipt";

/** Where receipts live when the project names no namespace. */
export const RECEIPT_DEFAULT_NAMESPACE = "default";

/**
 * The rendered value of a hash-flavor receipt that still carries reference
 * inputs at synthesis. References resolve at plan and at run, never at
 * synthesis (epic decision 5), so the row carries this note instead of a
 * digest hashed over placeholders.
 */
export const RECEIPT_UNRESOLVED_VALUE_NOTE =
  "unresolved at synthesis, reference inputs; the expectation resolves at plan and at run (chant #1703, decision 5)";

/** One segment of the receipt name. RFC 1123 DNS label, which is what each
 * dot-separated piece of a ConfigMap name has to be, and the `.` separator is
 * excluded from it so the identity stays unambiguous. */
const NAME_SEGMENT = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Kubernetes' own ceiling on a DNS subdomain, which a ConfigMap name is. */
const MAX_NAME_LENGTH = 253;

function checkSegment(field: string, value: string): string {
  if (value.length > 63 || !NAME_SEGMENT.test(value)) {
    throw new Error(
      `receipt name: ${field} "${value}" is not a valid DNS-1123 label, ` +
        `use lowercase letters, digits and "-" (the segment becomes one dot-separated piece of ` +
        `${RECEIPT_NAME_PREFIX}.<stack>.<env>.<effect>, which must be a valid ConfigMap name)`,
    );
  }
  return value;
}

/**
 * The ConfigMap name of one effect's receipt:
 * `chant-receipt.<stack>.<env>.<effect>`, from the resolved ownership marker
 * fields (epic decision 4). The single source of the name identity: the
 * serializer's rendered row, the receipt store's reads and writes, and the
 * observation leg all call this.
 */
export function receiptConfigMapName(stack: string, env: string, effect: string): string {
  const name = `${RECEIPT_NAME_PREFIX}.${checkSegment("stack", stack)}.${checkSegment("env", env)}.${checkSegment("effect", effect)}`;
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `receipt name: "${name}" is ${name.length} characters, over Kubernetes' ${MAX_NAME_LENGTH}-character ` +
        `limit for a ConfigMap name. Shorten the stack, the environment, or the effect.`,
    );
  }
  return name;
}

/** The project's receipt namespace: `k8s.receipts.namespace`, else `default`.
 * The serializer reads it off `SerializeContext.config` and the store reads it
 * off the project config, so both derive one namespace from one setting. */
export function receiptNamespaceFrom(config: Record<string, unknown> | undefined): string {
  const k8s = config?.k8s as { receipts?: { namespace?: unknown } } | undefined;
  const declared = k8s?.receipts?.namespace;
  return typeof declared === "string" && declared.length > 0 ? declared : RECEIPT_DEFAULT_NAMESPACE;
}

/** Name and namespace of one effect's receipt ConfigMap. */
export interface ReceiptConfigMapRef {
  name: string;
  namespace: string;
}

/** The full address of one effect's receipt ConfigMap. */
export function receiptConfigMapRef(
  stack: string,
  env: string,
  effect: string,
  namespace: string = RECEIPT_DEFAULT_NAMESPACE,
): ReceiptConfigMapRef {
  return { name: receiptConfigMapName(stack, env, effect), namespace };
}

/** True when a live object's labels mark it a chant effect receipt. Any
 * non-empty value counts: the label's presence is the claim, and a sweep must
 * err on the side of keeping. */
export function isEffectReceiptObject(labels: Record<string, unknown> | undefined): boolean {
  const value = labels?.[RECEIPT_LABEL_KEY];
  return typeof value === "string" && value.length > 0;
}

/** One rendered receipt row, as the comment block carries it. */
export interface RenderedReceiptRow {
  kind: typeof RECEIPT_CONFIGMAP_REF.kind;
  namespace: string;
  name: string;
  data: Record<string, string>;
}

/**
 * Render the receipt block the serializer appends to the manifest stream.
 * Deterministic: one line, entity names sorted.
 */
export function renderReceiptComment(rows: Record<string, RenderedReceiptRow>): string {
  const sorted: Record<string, RenderedReceiptRow> = {};
  for (const name of Object.keys(rows).sort()) sorted[name] = rows[name];
  return `${EFFECT_RECEIPTS_COMMENT_MARKER}${JSON.stringify(sorted)}`;
}

/**
 * Read the receipt rows back out of a build output. Returns an empty record
 * for an output that carries no block, which is every project that declares no
 * receipt. Never throws: an unparseable block is no block, and the observation
 * leg reports the receipts it could not address as absent rather than
 * inventing one.
 */
export function parseReceiptComment(buildOutput: string): Record<string, RenderedReceiptRow> {
  const start = buildOutput.lastIndexOf(EFFECT_RECEIPTS_COMMENT_MARKER);
  if (start < 0) return {};
  const end = buildOutput.indexOf("\n", start);
  const line = buildOutput.slice(start + EFFECT_RECEIPTS_COMMENT_MARKER.length, end < 0 ? undefined : end);
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, RenderedReceiptRow>;
  } catch {
    return {};
  }
}

/**
 * A k8s-materialized effect receipt: core's declaration shape (so
 * `isEffectReceipt`, `effect(...)`, lint, and the plan engine all recognize it
 * through the marker), under the k8s lexicon and the real resource kind.
 */
export interface K8sEffectReceiptDeclaration extends Declarable {
  readonly [EFFECT_RECEIPT_MARKER]: true;
  readonly lexicon: "k8s";
  readonly entityType: typeof K8S_EFFECT_RECEIPT_ENTITY_TYPE;
  /** The receipt's own name (the export-level identity of the witness). */
  readonly name: string;
  /** The effect this receipt witnesses, the name's final segment. */
  readonly effect: string;
  /** How the receipt is compared: mere presence, or a digest of the inputs. */
  readonly flavor: EffectReceiptFlavor;
  /** The effect's inputs as recorded at synthesis (references as placeholders). */
  readonly inputs: Readonly<Record<string, unknown>>;
}

/**
 * Declare a k8s-materialized effect receipt. Same signature and semantics as
 * core's `EffectReceipt` (#1831), whose factory validates and freezes the
 * options, but the declaration lands in the k8s partition, so the k8s
 * serializer renders the ConfigMap row and the receipt store
 * (./receipt-store.ts) is its writer. Pass the returned const straight to the
 * `effect(...)` op step.
 */
export function EffectReceipt(name: string, options: EffectReceiptOptions): K8sEffectReceiptDeclaration {
  // Fail at declaration, not at serialize: the effect is the name's final
  // segment, and a name that cannot become a segment has no receipt address.
  if (typeof options?.effect === "string" && options.effect.length > 0) {
    checkSegment("effect", options.effect);
  }
  const core = CoreEffectReceipt(name, options);
  const decl: K8sEffectReceiptDeclaration = {
    [DECLARABLE_MARKER]: true,
    [EFFECT_RECEIPT_MARKER]: true,
    lexicon: "k8s",
    entityType: K8S_EFFECT_RECEIPT_ENTITY_TYPE,
    name: core.name,
    effect: core.effect,
    flavor: core.flavor,
    // The same frozen structure the core factory built: intrinsic inputs stay
    // live so discovery can stamp logical names onto attr-refs.
    inputs: core.inputs,
  };
  // Declared fields immutable, object extensible for discovery's own
  // symbol-keyed metadata, the same lock the core factory applies.
  for (const key of Object.keys(decl)) {
    Object.defineProperty(decl, key, { writable: false, configurable: false });
  }
  return decl;
}
