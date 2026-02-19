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
