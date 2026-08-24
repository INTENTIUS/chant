/**
 * Effect receipts (chant #1831, epic #1703).
 *
 * A RECEIPT is the declared witness that an out-of-band effect (a migration,
 * a seed job, a one-shot bootstrap) has run — declared, diffed, and observed
 * like any resource, but observe-only to the generic apply path: the
 * `effect()` step (#1834) is the sole writer, on success, last. Anything
 * else silently converts at-least-once into never (epic decision log, item
 * 3). That write-exclusion is #1832's enforcement; what THIS module provides
 * is the recognition marker that makes it possible: core code (lint, plan,
 * apply) identifies receipts via {@link EFFECT_RECEIPT_MARKER} without any
 * lexicon knowledge, while per-lexicon rows (#1835's `AWS::SSM::Parameter`)
 * materialize them as real resources. Unlike a secret provenance declaration
 * (./secret-provenance.ts), a receipt DOES serialize — the marker identifies,
 * it does not exclude.
 *
 * The resolution split (epic decision log, item 5):
 *
 * - STATIC inputs hash at synthesis, in the serializer — a fully static
 *   receipt's expectation is already known when the template is written
 *   ({@link receiptExpectation}).
 * - REFERENCE inputs (attr-refs and other intrinsics — deploy-time values)
 *   are recorded in placeholder form at synthesis and resolve in the plan
 *   engine (#1832) and again in the effect step (#1834), via
 *   {@link resolveReceiptExpectation}. Synthesis resolves NOTHING:
 *   {@link receiptExpectation} refuses a hash-flavor receipt that still
 *   carries references rather than hashing a placeholder.
 * - Build-time `params.*` are not references here: they fold to literals
 *   before discovery ever runs (../params.ts), so by the time this factory
 *   sees them they are static.
 *
 * Nothing in this module reads live state. Every function is pure over the
 * declaration and, for resolution, the caller-supplied resolver.
 *
 * Hashing is JCS-style canonical JSON (RFC 8785 shape: sorted keys, standard
 * ECMAScript number/string encoding — implemented minimally here, no
 * dependency) digested with sha256 ({@link canonicalJson},
 * `sha256:<hex>` like the build-ledger digests in ./lifecycle/build-ledger.ts).
 */

import { createHash } from "node:crypto";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { isIntrinsic, type Intrinsic } from "./intrinsic";

/** The closed union of receipt flavors. */
export type EffectReceiptFlavor = "existence" | "hash";

/** Every receipt flavor, for exhaustiveness checks. */
export const EFFECT_RECEIPT_FLAVORS: readonly EffectReceiptFlavor[] = ["existence", "hash"];

/** Marker symbol identifying an effect receipt. `Symbol.for` so it survives
 * the entity-wire codec (./discovery/entity-wire-codec.ts) and so a lexicon
 * row can stamp the SAME symbol on its materialized resource — core's lint
 * (#1833), plan (#1832), and apply write-exclusion recognize receipts through
 * this marker alone, lexicon-independently. */
export const EFFECT_RECEIPT_MARKER = Symbol.for("chant.effect-receipt");

/** The `entityType` the core factory stamps. Lexicon materialization rows
 * (#1835) use their own entityType and carry the marker instead. */
export const EFFECT_RECEIPT_ENTITY_TYPE = "Chant::EffectReceipt";

/**
 * The expected stored value of an `existence`-flavor receipt: a fixed marker
 * constant, the same for every existence receipt. Present-and-equal means the
 * effect has run; anything else renders an effect-will-fire row (#1832).
 */
export const EXISTENCE_EXPECTATION = "chant.effect-receipt:exists";

/**
 * An effect receipt declaration — a Declarable, so discovery collects it,
 * `chant list` shows it, and (unlike a secret declaration) serialization
 * keeps it: a lexicon row turns it into a real, observable resource.
 */
export interface EffectReceiptDeclaration extends Declarable {
  readonly [EFFECT_RECEIPT_MARKER]: true;
  readonly lexicon: "chant";
  readonly entityType: typeof EFFECT_RECEIPT_ENTITY_TYPE;
  /** The receipt's own name (the export-level identity of the witness). */
  readonly name: string;
  /** The effect this receipt witnesses — the identity the `effect()` step
   * (#1834) and the receipt path (#1835) key on. */
  readonly effect: string;
  /** How the receipt is compared: mere presence, or a digest of the inputs. */
  readonly flavor: EffectReceiptFlavor;
  /**
   * The effect's inputs as recorded at synthesis: static values verbatim,
   * references (intrinsics) kept in placeholder form — never resolved here.
   */
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** Factory options for {@link EffectReceipt}. */
export interface EffectReceiptOptions {
  /** The effect this receipt witnesses. Non-empty. */
  readonly effect: string;
  /** `existence` — presence is the witness; `hash` — a digest of the inputs
   * is, so changed inputs re-propose the fire. */
  readonly flavor: EffectReceiptFlavor;
  /** The effect's inputs. Static values hash at synthesis; intrinsic values
   * (attr-refs, deploy-time references) resolve at plan and at run. */
  readonly inputs?: Record<string, unknown>;
}

/**
 * Declare an effect receipt. The returned object is a locked Declarable:
 * declared fields are immutable, plain-data input structures are frozen
 * (intrinsics are left live — discovery still stamps logical names onto
 * attr-refs), and the top-level object stays extensible for discovery's own
 * symbol-keyed metadata.
 */
export function EffectReceipt(name: string, options: EffectReceiptOptions): EffectReceiptDeclaration {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("EffectReceipt: `name` must be a non-empty string");
  }
  if (typeof options?.effect !== "string" || options.effect.length === 0) {
    throw new Error(`EffectReceipt("${name}"): \`effect\` must be a non-empty string`);
  }
  if (!EFFECT_RECEIPT_FLAVORS.includes(options.flavor)) {
    throw new Error(
      `EffectReceipt("${name}"): unknown flavor "${String(options.flavor)}" — ` +
        `expected one of ${EFFECT_RECEIPT_FLAVORS.join(", ")}`,
    );
  }
  if (options.inputs !== undefined && (typeof options.inputs !== "object" || options.inputs === null || Array.isArray(options.inputs))) {
    throw new Error(`EffectReceipt("${name}"): \`inputs\` must be a plain object when present`);
  }

  const inputs = deepFreezeStatic({ ...(options.inputs ?? {}) }) as Readonly<Record<string, unknown>>;

  const decl: EffectReceiptDeclaration = {
    [DECLARABLE_MARKER]: true,
    [EFFECT_RECEIPT_MARKER]: true,
    lexicon: "chant",
    entityType: EFFECT_RECEIPT_ENTITY_TYPE,
    name,
    effect: options.effect,
    flavor: options.flavor,
    inputs,
  };
  // Declared fields immutable, object extensible — same shape secret
  // declarations use (./secret-provenance.ts's lockDeclaredFields).
  for (const key of Object.keys(decl)) {
    Object.defineProperty(decl, key, { writable: false, configurable: false });
  }
  return decl;
}

/** Freeze plain objects and arrays in place, leaving intrinsics (and any
 * other class instance) untouched — discovery mutates AttrRefs when it
 * assigns logical names. */
function deepFreezeStatic(value: unknown, seen: Set<object> = new Set()): unknown {
  if (typeof value !== "object" || value === null || isIntrinsic(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const el of value) deepFreezeStatic(el, seen);
    return Object.freeze(value);
  }
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    for (const el of Object.values(value)) deepFreezeStatic(el, seen);
    return Object.freeze(value);
  }
  return value;
}

/** Type guard for an effect receipt — the recognition read core's guards use.
 * True for the core declaration AND for any lexicon-materialized resource
 * that carries the marker. */
export function isEffectReceipt(value: unknown): value is EffectReceiptDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    EFFECT_RECEIPT_MARKER in value &&
    (value as Record<symbol, unknown>)[EFFECT_RECEIPT_MARKER] === true
  );
}

/**
 * Extract the effect receipts from a discovered entity map — the read surface
 * for lint (#1833), the plan engine (#1832), and the apply write-exclusion.
 * Keyed by entity name (export name), the same key `DiscoveryResult.entities`
 * uses.
 */
export function collectEffectReceipts(
  entities: ReadonlyMap<string, Declarable>,
): Map<string, EffectReceiptDeclaration> {
  const out = new Map<string, EffectReceiptDeclaration>();
  for (const [name, entity] of entities) {
    if (isEffectReceipt(entity)) out.set(name, entity);
  }
  return out;
}

/**
 * Split an entity map into the apply-bound set and the receipts (#1832).
 *
 * The write-exclusion seam: receipts are observe-only to the generic apply
 * path — the `effect()` step is the sole writer (epic #1703, decision 3), and
 * a receipt the generic apply stamped would silently convert at-least-once
 * into never. The build calls this at serializer-input assembly, the one core
 * choke point every applier's input flows through (appliers consume serialized
 * build outputs), so no lexicon's serialized apply document ever contains a
 * receipt and no applier's desired or prune set can. Receipts still reach the
 * serializer — for visibility rendering outside the apply-bound document
 * (#1835) — via `SerializeContext.receipts`, never in the entity map.
 */
export function splitReceiptEntities(entities: ReadonlyMap<string, Declarable>): {
  applyBound: Map<string, Declarable>;
  receipts: Map<string, EffectReceiptDeclaration>;
} {
  const applyBound = new Map<string, Declarable>();
  const receipts = new Map<string, EffectReceiptDeclaration>();
  for (const [name, entity] of entities) {
    if (isEffectReceipt(entity)) receipts.set(name, entity);
    else applyBound.set(name, entity);
  }
  return { applyBound, receipts };
}

// ─────────────────────────────────────────────────────────────────────────
// Canonical hashing — JCS-style canonical JSON + sha256.
// ─────────────────────────────────────────────────────────────────────────

/**
 * JCS-style canonical JSON (the RFC 8785 shape, implemented minimally):
 * object keys sorted by UTF-16 code units, numbers and strings in standard
 * ECMAScript `JSON.stringify` encoding, no insignificant whitespace.
 * `toJSON()` is honored the way `JSON.stringify` honors it — which is what
 * puts an intrinsic's PLACEHOLDER envelope (e.g. an attr-ref's
 * `{"__attrRef":{...}}`) into the canonical form rather than a resolved
 * value. Non-representable values (undefined outside an object property,
 * functions, symbols, bigints, non-finite numbers, cycles) throw — a hash
 * input silently coerced is a wrong expectation.
 */
export function canonicalJson(value: unknown): string {
  const out = encodeCanonical(value, "$", new Set());
  if (out === undefined) {
    throw new Error(`canonicalJson: value at $ is not representable in JSON`);
  }
  return out;
}

/** Returns undefined only for values JSON.stringify would drop as an object
 * property (undefined); throws for everything else non-representable. */
function encodeCanonical(value: unknown, path: string, seen: Set<object>): string | undefined {
  // toJSON first, like JSON.stringify — once per node.
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      value = (toJSON as () => unknown).call(value);
    }
  }
  if (value === undefined) return undefined;
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: non-finite number at ${path}`);
      }
      return String(value); // ECMAScript ToString — what JCS specifies.
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new Error(`canonicalJson: bigint at ${path} is not representable in JSON`);
    case "function":
    case "symbol":
      throw new Error(`canonicalJson: ${typeof value} at ${path} is not representable in JSON`);
  }
  const obj = value as object;
  if (seen.has(obj)) {
    throw new Error(`canonicalJson: circular structure at ${path}`);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((el, i) => encodeCanonical(el, `${path}[${i}]`, seen) ?? "null");
      return `[${parts.join(",")}]`;
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const encoded = encodeCanonical((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

function sha256Digest(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ─────────────────────────────────────────────────────────────────────────
// The resolution split.
// ─────────────────────────────────────────────────────────────────────────

/** The paths (dot/bracket, rooted at `inputs`) of every reference (intrinsic)
 * input still unresolved on the receipt. Empty means the receipt is fully
 * static and {@link receiptExpectation} can stamp its digest at synthesis. */
export function referenceInputPaths(receipt: EffectReceiptDeclaration): string[] {
  const paths: string[] = [];
  collectReferencePaths(receipt.inputs, "inputs", paths, new Set());
  return paths;
}

function collectReferencePaths(value: unknown, path: string, out: string[], seen: Set<object>): void {
  if (typeof value !== "object" || value === null) return;
  if (isIntrinsic(value)) {
    out.push(path);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((el, i) => collectReferencePaths(el, `${path}[${i}]`, out, seen));
    return;
  }
  for (const [key, el] of Object.entries(value)) {
    collectReferencePaths(el, `${path}.${key}`, out, seen);
  }
}

/**
 * The receipt's expected stored value, computable at synthesis:
 *
 * - `existence` → {@link EXISTENCE_EXPECTATION}, always.
 * - `hash` → `sha256:<hex>` over the canonical JSON of
 *   `{ effect, inputs }` — the effect name is bound into the digest so the
 *   same inputs under a different effect never collide.
 *
 * A hash-flavor receipt that still carries reference inputs THROWS instead
 * of hashing placeholders: synthesis resolves nothing (epic decision log,
 * item 5). The plan engine and the effect step get the digest through
 * {@link resolveReceiptExpectation}.
 */
export function receiptExpectation(receipt: EffectReceiptDeclaration): string {
  if (receipt.flavor === "existence") return EXISTENCE_EXPECTATION;
  const refs = referenceInputPaths(receipt);
  if (refs.length > 0) {
    throw new Error(
      `receiptExpectation("${receipt.name}"): unresolved reference inputs at ${refs.join(", ")} — ` +
        `references resolve at plan and at run, never at synthesis; ` +
        `use resolveReceiptExpectation with a resolver`,
    );
  }
  return sha256Digest(canonicalJson({ effect: receipt.effect, inputs: receipt.inputs }));
}

/**
 * Resolves one reference input to its live value. `path` is the reference's
 * location (as {@link referenceInputPaths} renders it). Must return a
 * JSON-representable value — returning `undefined` or another intrinsic is
 * an error, reported with the path.
 */
export type ReceiptInputResolver = (ref: Intrinsic, path: string) => unknown;

/**
 * The receipt's expected stored value with references resolved — the form
 * the plan engine (#1832) compares against the live receipt and the effect
 * step (#1834) writes on success. Deterministic over the receipt and the
 * resolver's answers; resolves nothing itself and reads no live state (the
 * resolver is the caller's seam to deploy-time values).
 */
export function resolveReceiptExpectation(
  receipt: EffectReceiptDeclaration,
  resolver: ReceiptInputResolver,
): string {
  if (receipt.flavor === "existence") return EXISTENCE_EXPECTATION;
  const resolved = resolveValue(receipt.inputs, "inputs", resolver, new Set());
  return sha256Digest(canonicalJson({ effect: receipt.effect, inputs: resolved }));
}

function resolveValue(
  value: unknown,
  path: string,
  resolver: ReceiptInputResolver,
  seen: Set<object>,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (isIntrinsic(value)) {
    const resolved = resolver(value, path);
    if (resolved === undefined) {
      throw new Error(`resolveReceiptExpectation: resolver returned undefined for reference at ${path}`);
    }
    if (isIntrinsic(resolved)) {
      throw new Error(`resolveReceiptExpectation: resolver returned another reference for ${path}`);
    }
    return resolved;
  }
  if (seen.has(value)) {
    throw new Error(`resolveReceiptExpectation: circular structure at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((el, i) => resolveValue(el, `${path}[${i}]`, resolver, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, el] of Object.entries(value)) {
      out[key] = resolveValue(el, `${path}.${key}`, resolver, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
