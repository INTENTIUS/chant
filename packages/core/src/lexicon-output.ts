import { INTRINSIC_MARKER, type Intrinsic } from "./intrinsic";
import { AttrRef } from "./attrref";

/**
 * Represents a cross-lexicon output that bridges a producing lexicon (e.g. AWS)
 * with any consuming lexicon (e.g. GitHub, Cloudflare).
 *
 * Implements Intrinsic so it can be used as Value<string> anywhere.
 */
export class LexiconOutput implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  readonly sourceLexicon: string;
  readonly sourceEntity: string;
  readonly sourceAttribute: string;
  readonly outputName: string;
  /** @internal WeakRef to the source entity object for identity-based matching */
  readonly _sourceParent: WeakRef<object>;

  constructor(ref: AttrRef, name: string) {
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
   * Create a LexiconOutput with an auto-generated name from entity name and attribute.
   * Used during cross-lexicon ref auto-detection.
   *
   * @param ref - The AttrRef pointing to the source entity
   * @param entityName - The logical name of the source entity
   * @returns A LexiconOutput with name `{entityName}_{attribute}`
   */
  static auto(ref: AttrRef, entityName: string): LexiconOutput {
    const name = `${entityName}_${ref.attribute}`;
    const output = new LexiconOutput(ref, name);
    output._setSourceEntity(entityName);
    return output;
  }

  toJSON(): { "chant::output": string } {
    return { "chant::output": this.outputName };
  }
}

/**
 * Create a LexiconOutput from an AttrRef and a user-provided output name.
 *
 * Usage:
 * ```ts
 * const bucketArn = output(dataBucket.arn, "DataBucketArn");
 * ```
 */
export function output(ref: AttrRef, name: string): LexiconOutput {
  return new LexiconOutput(ref, name);
}

/**
 * Type guard to check if a value is a LexiconOutput
 */
export function isLexiconOutput(value: unknown): value is LexiconOutput {
  return value instanceof LexiconOutput;
}
