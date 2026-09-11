import { INTRINSIC_MARKER, type Intrinsic } from "./intrinsic";

/**
 * Reference to an attribute of a parent entity.
 * Lexicon serializers read `getLogicalName()` and `attribute` to produce
 * their own output format (e.g. CloudFormation `Fn::GetAttr`).
 */
export class AttrRef implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  readonly parent: WeakRef<object>;
  readonly attribute: string;
  private logicalName?: string;

  constructor(parent: object, attribute: string) {
    this.parent = new WeakRef(parent);
    this.attribute = attribute;
  }

  /**
   * Set the logical name for this attribute reference
   * @internal
   */
  _setLogicalName(name: string): void {
    this.logicalName = name;
  }

  /**
   * Get the logical name assigned to this attribute reference.
   */
  getLogicalName(): string | undefined {
    return this.logicalName;
  }

  /**
   * Refuse to become a string (#2349).
   *
   * An `AttrRef` stands for a value the build resolves later, so it has no
   * string form here. Without this, `` `${bucket.arn}-suffix` `` produced
   * `"[object Object]-suffix"` and shipped it — and the fold path produced
   * exactly the same wrong string from the `{__attrRef}` envelope, so the two
   * paths agreed and the differential harness reported nothing. Agreement on a
   * wrong value is the failure this class of check exists to catch, which is
   * why this throws rather than returning something more helpful-looking.
   *
   * `toJSON` below is the honest serialization and is untouched: a serializer
   * that wants the envelope asks for it by name.
   */
  toString(): never {
    const where = this.logicalName ? `${this.logicalName}.${this.attribute}` : `.${this.attribute}`;
    throw new Error(
      `A resource attribute reference (${where}) has no string form: it stands for a value the build ` +
        "resolves later, and interpolating it into a plain template literal would produce " +
        '"[object Object]". Use the lexicon\'s own intrinsic, whose interior handles references — ' +
        "`Sub`${…}`` for CloudFormation — or move the reference out of the template.",
    );
  }

  /**
   * The same refusal for `+` and for anything else that coerces, so
   * `"prefix" + bucket.arn` fails where `` `${bucket.arn}` `` fails rather
   * than taking a different path to the same wrong string.
   */
  [Symbol.toPrimitive](): never {
    return this.toString();
  }

  /**
   * Serialize to a generic envelope. Lexicon-specific serializers should
   * read `getLogicalName()` and `attribute` directly instead of relying
   * on this format.
   * @throws {Error} If logical name has not been set
   */
  toJSON(): { __attrRef: { entity: string; attribute: string } } {
    if (!this.logicalName) {
      throw new Error(
        `Cannot serialize AttrRef for attribute "${this.attribute}": logical name not set`
      );
    }
    return {
      __attrRef: { entity: this.logicalName, attribute: this.attribute },
    };
  }
}
