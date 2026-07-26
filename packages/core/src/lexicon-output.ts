import { INTRINSIC_MARKER, type Intrinsic } from "./intrinsic";
import { AttrRef } from "./attrref";

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
 * Accepts either an AttrRef (resource attribute reference) or any Intrinsic
 * (e.g. Sub, Join) for computed output values like constructed URLs.
 */
export class LexiconOutput implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
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

  constructor(ref: AttrRef | Intrinsic | string, name: string) {
    if (ref instanceof AttrRef) {
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
    } else {
      // Intrinsic (Sub, Join, Ref, etc.) — no parent entity tracking needed
      // Note: `string` in the union is for attribute accessors typed as string at the
      // TypeScript level (they are AttrRef at runtime, caught by instanceof above).
      this.sourceLexicon = "";
      this.sourceEntity = "";
      this.sourceAttribute = null;
      this.outputName = name;
      this._sourceParent = null;
      this._intrinsic = typeof ref !== "string" ? ref : null;
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
   * For AttrRef-based outputs: emits Fn::GetAtt.
   * For Intrinsic-based outputs: delegates to the intrinsic's toJSON().
   */
  getOutputValue(): unknown {
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
 * Create a LexiconOutput from an AttrRef or Intrinsic and a user-provided output name.
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
 */
export function output(ref: AttrRef | Intrinsic | string, name: string): LexiconOutput {
  return new LexiconOutput(ref, name);
}

/**
 * Type guard to check if a value is a LexiconOutput
 */
export function isLexiconOutput(value: unknown): value is LexiconOutput {
  return value instanceof LexiconOutput;
}
