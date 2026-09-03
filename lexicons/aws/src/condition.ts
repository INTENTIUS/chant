/**
 * CloudFormation template condition (#2068).
 *
 * A `Condition` declarable is lifted into the template's `Conditions`
 * section by the serializer, the way `Parameter` is lifted into
 * `Parameters`. Reference it from a resource's `Condition` attribute, an
 * output's `condition` option, `If(...)`, or inside another condition via
 * `And`/`Or`/`Not`.
 */

import { DECLARABLE_MARKER, isDeclarable, type Declarable } from "@intentius/chant/declarable";
import { isIntrinsic, type Intrinsic } from "@intentius/chant/intrinsic";

export const CONDITION_ENTITY_TYPE = "AWS::CloudFormation::Condition";

export class Condition implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = CONDITION_ENTITY_TYPE;
  /** The boolean expression: an `Equals`/`And`/`Or`/`Not` intrinsic. */
  readonly expression: Intrinsic;

  constructor(expression: Intrinsic) {
    if (!isIntrinsic(expression)) {
      throw new Error(
        "new Condition(expression): expression must be a condition intrinsic (Equals, And, Or, Not)",
      );
    }
    this.expression = expression;
  }
}

/**
 * Type guard for the `Condition` declarable. Duck-typed on `entityType`
 * rather than `instanceof` so a lexicon built against a separate copy of
 * `@intentius/chant` still matches (the #1137 convention).
 */
export function isCondition(value: unknown): value is Condition {
  return isDeclarable(value) && value.entityType === CONDITION_ENTITY_TYPE;
}
