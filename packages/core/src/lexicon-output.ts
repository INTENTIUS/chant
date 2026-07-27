import { INTRINSIC_MARKER, isIntrinsic, type Intrinsic } from "./intrinsic";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";

/** A value `output()` accepts that is already fully resolved — not a
 * reference to anything, just data the author computed (a literal, a prop,
 * a template string). See chant #1121. */
export type LexiconOutputLiteral = string | number | boolean;

/**
 * Marker symbol for LexiconOutput identification (chant #1122).
 *
 * A GLOBAL symbol (via `Symbol.for`), like every other chant-core brand
 * check — `DECLARABLE_MARKER`, `STACK_OUTPUT_MARKER`, `INTRINSIC_MARKER` —
 * holds across separately-loaded copies of chant-core the way `instanceof`
 * does not. Two copies in one process is a plain npm-dedupe outcome: a
 * lexicon pinned to a chant range that does not overlap the project's own
 * gets a nested `node_modules/@intentius/chant`, and a project file
 * importing `output` from that lexicon then holds a different `LexiconOutput`
 * class than the CLI does. `instanceof LexiconOutput` returns false for a
 * real output built by the other copy, and every `Outputs` entry vanishes
 * silently.
 *
 * Installed non-enumerably in the constructor (not as a public class field)
 * so a shallow spread/clone of a real instance — which would already lack
 * its prototype methods (`getOutputValue()`, `_setSourceEntity()`, …) — does
 * not silently pick up the marker and pass this guard too.
 */
export const LEXICON_OUTPUT_MARKER = Symbol.for("chant.lexiconOutput");

/**
 * Sanitize auto-generated Output name parts into a valid CloudFormation
 * logical id. Real CloudFormation logical ids (including `Outputs` keys)
 * must match `^[A-Za-z0-9]+$` — no dots, underscores, or other punctuation.
 *
 * Splits every part on runs of non-alphanumeric characters (dots from a
 * nested `Fn::GetAtt` attribute path, underscores, hyphens, etc.) and
 * re-joins the resulting segments in camelCase. This keeps the id
 * deterministic and unique per (entityName, attribute) pair while
 * discarding only punctuation — no information is lost, so two distinct
 * inputs only collide if they already differ solely by punctuation.
 *
 * @internal
 */
export function sanitizeLogicalId(...parts: string[]): string {
  const segments = parts
    .join("_")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return "Output";

  return segments
    .map((segment, i) => (i === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
    .join("");
}

/**
 * Represents a cross-lexicon output that bridges a producing lexicon (e.g. AWS)
 * with any consuming lexicon (e.g. GitHub, Cloudflare).
 *
 * Implements Intrinsic so it can be used as Value<string> anywhere.
 *
 * Accepts an AttrRef (resource attribute reference), any Intrinsic (e.g. Sub,
 * Join) for computed output values like constructed URLs, or an already-
 * resolved literal (string/number/boolean) — a constant the author's code
 * computed rather than a reference to anything (chant #1121).
 */
export class LexiconOutput implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  /** @internal Brand marker — see {@link LEXICON_OUTPUT_MARKER}. Declared
   * here only for type purposes; the real, non-enumerable property is
   * installed by the constructor. */
  readonly [LEXICON_OUTPUT_MARKER]!: true;
  readonly sourceLexicon: string;
  readonly sourceEntity: string;
  readonly sourceAttribute: string | null;
  readonly outputName: string;
  /** @internal WeakRef to the source entity object for identity-based matching */
  readonly _sourceParent: WeakRef<object> | null;
  /**
   * @internal Intrinsic value when constructed from an Intrinsic rather than AttrRef.
   * Readable outside the class (like `_sourceParent` above) so the entity-wire
   * encoder can reach it without an `as unknown as` cast that would erase type
   * checking on every field it reads (#1047).
   */
  readonly _intrinsic: Intrinsic | null;
  /**
   * @internal The already-resolved literal (string/number/boolean) when
   * constructed from neither an AttrRef nor an Intrinsic — non-null exactly
   * when `_intrinsic` is null AND `sourceAttribute` is null. There is no
   * source entity or attribute to reference, so `getOutputValue()` returns
   * this value verbatim rather than fabricating a `Fn::GetAtt` out of an
   * unset attribute (chant #1121). Readable outside the class for the same
   * reason as `_intrinsic`/`_sourceParent` above.
   */
  readonly _literalValue: LexiconOutputLiteral | null;

  constructor(ref: AttrRef | Intrinsic | LexiconOutputLiteral, name: string) {
    Object.defineProperty(this, LEXICON_OUTPUT_MARKER, {
      value: true,
      enumerable: false,
    });
    // Duck-type, not `instanceof` (chant #1137): a lexicon built against a
    // separate copy of `@intentius/chant` produces AttrRefs that fail
    // `instanceof AttrRef` here but carry the same shape — and since AttrRef
    // also implements Intrinsic, missing this branch does not fail loud.
    // The value instead falls into the `isIntrinsic(ref)` branch below,
    // stored as `_intrinsic` rather than an AttrRef-sourced output, so
    // `getOutputValue()` later calls the foreign AttrRef's own `toJSON()`
    // (the `{__attrRef}` wire envelope) instead of emitting `Fn::GetAtt` —
    // a broken Output emitted with no error at synth time.
    if (isAttrRefLike(ref)) {
      const parent = ref.parent.deref();
      if (!parent) {
        throw new Error("Cannot create LexiconOutput: parent entity has been garbage collected");
      }

      if (!("lexicon" in parent) || typeof (parent as Record<string, unknown>).lexicon !== "string") {
        throw new Error("Cannot create LexiconOutput: parent entity has no lexicon field");
      }

      this.sourceLexicon = (parent as Record<string, unknown>).lexicon as string;
      this.sourceEntity = "";
      this.sourceAttribute = ref.attribute;
      this.outputName = name;
      this._sourceParent = ref.parent;
      this._intrinsic = null;
      this._literalValue = null;
    } else if (isIntrinsic(ref)) {
      // Intrinsic (Sub, Join, Ref, etc.) — no parent entity tracking needed.
      this.sourceLexicon = "";
      this.sourceEntity = "";
      this.sourceAttribute = null;
      this.outputName = name;
      this._sourceParent = null;
      this._intrinsic = ref;
      this._literalValue = null;
    } else if (typeof ref === "string" || typeof ref === "number" || typeof ref === "boolean") {
      // An already-resolved literal — a real string/number/boolean the
      // caller computed (a prop, a template string, a plain constant), not
      // a reference to anything. The `string` arm of the exported type
      // exists for a documented reason: a generated resource's attribute
      // accessor is typed `string` at the TypeScript level but is a real
      // `AttrRef` at runtime, caught by the `isAttrRefLike` check above — so
      // anything that reaches this branch genuinely has no source entity
      // or attribute, and is recorded to be emitted as a plain `Value`
      // rather than a fabricated `Fn::GetAtt` (chant #1121).
      this.sourceLexicon = "";
      this.sourceEntity = "";
      this.sourceAttribute = null;
      this.outputName = name;
      this._sourceParent = null;
      this._intrinsic = null;
      this._literalValue = ref;
    } else {
      // Neither a reference NOR a resolved value — most commonly `undefined`
      // from accessing a resource member that looks like an attribute but
      // isn't one (a typo, or a genuine prop that was never wired onto the
      // instance as either an AttrRef or an echoed literal). Silently
      // treating this as a literal would trade one invalid Output (a
      // fabricated `Fn::GetAtt`) for another (a `Value` that is missing or
      // `null`) — fail loudly instead, the same call `stackOutput()` already
      // makes for a ref it cannot anchor (chant #1121).
      throw new Error(
        `output(ref, "${name}"): ref must be an AttrRef, an Intrinsic, or an already-resolved string/number/boolean — got ${ref === null ? "null" : typeof ref} instead. If this came from a resource member access (e.g. "resource.SomeField"), that member is neither a generated attribute nor a real value here — check for a typo or a property that CloudFormation does not expose via Fn::GetAtt.`,
      );
    }
  }

  /**
   * Set the source entity logical name.
   * Called during build when entity names are resolved.
   * @internal
   */
  _setSourceEntity(name: string): void {
    (this as { sourceEntity: string }).sourceEntity = name;
  }

  /**
   * Returns the CloudFormation Output Value for this output.
   * For a literal output: the resolved value itself, verbatim.
   * For AttrRef-based outputs: emits Fn::GetAtt.
   * For Intrinsic-based outputs: delegates to the intrinsic's toJSON().
   */
  getOutputValue(): unknown {
    if (this._literalValue !== null) {
      return this._literalValue;
    }
    if (this._intrinsic) {
      return this._intrinsic.toJSON();
    }
    return { "Fn::GetAtt": [this.sourceEntity, this.sourceAttribute] };
  }

  /**
   * Create a LexiconOutput with an auto-generated name from entity name and attribute.
   * Used during cross-lexicon ref auto-detection.
   *
   * The name is sanitized to a valid CloudFormation logical id (see
   * {@link sanitizeLogicalId}) since it is used verbatim as the `Outputs`
   * key by lexicon serializers (e.g. AWS CloudFormation), which reject
   * dots or underscores in logical ids.
   *
   * @param ref - The AttrRef pointing to the source entity
   * @param entityName - The logical name of the source entity
   * @returns A LexiconOutput with a name derived from `{entityName}{Attribute}`
   */
  static auto(ref: AttrRef, entityName: string): LexiconOutput {
    const name = sanitizeLogicalId(entityName, ref.attribute);
    const output = new LexiconOutput(ref, name);
    output._setSourceEntity(entityName);
    return output;
  }

  toJSON(): { "chant::output": string } {
    return { "chant::output": this.outputName };
  }
}

/**
 * Create a LexiconOutput from an AttrRef, an Intrinsic, or an already-
 * resolved literal, and a user-provided output name.
 *
 * Usage with AttrRef:
 * ```ts
 * const bucketArn = output(dataBucket.arn, "DataBucketArn");
 * ```
 *
 * Usage with an intrinsic (e.g. a constructed URL):
 * ```ts
 * const solrUrl = output(Sub`http://${Ref(albDnsName)}/solr`, "solrUrl");
 * ```
 *
 * Usage with a literal (chant #1121) — a real value the caller already
 * computed, not a reference:
 * ```ts
 * const apiVersion = output("v1", "ApiVersion");
 * ```
 */
export function output(ref: AttrRef | Intrinsic | LexiconOutputLiteral, name: string): LexiconOutput {
  return new LexiconOutput(ref, name);
}

/**
 * Type guard to check if a value is a LexiconOutput.
 *
 * Structural, not `instanceof` (chant #1122) — keys off {@link
 * LEXICON_OUTPUT_MARKER}, a global symbol, so it holds across separately-
 * loaded copies of chant-core the way `instanceof` does not. Every caller
 * (`collect.ts`, `build.ts`, `graph-ir.ts`, `entity-wire-codec.ts`) reads
 * only own-prototype members off the result (`outputName`, `_sourceParent`,
 * `_setSourceEntity()`, `getOutputValue()`), all of which work identically
 * on a cross-copy instance.
 */
export function isLexiconOutput(value: unknown): value is LexiconOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    LEXICON_OUTPUT_MARKER in value &&
    (value as Record<symbol, unknown>)[LEXICON_OUTPUT_MARKER] === true
  );
}
