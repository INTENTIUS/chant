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
import { getLogicalName } from "@intentius/chant/utils";

export const CONDITION_ENTITY_TYPE = "AWS::CloudFormation::Condition";

export class Condition implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = CONDITION_ENTITY_TYPE;
  /** The boolean expression: an `Equals`/`And`/`Or`/`Not` intrinsic. */
  readonly expression: Intrinsic;
  /** The condition's key in the template's `Conditions`, when it is not the
   * export name. A template may use one name for a condition and a
   * parameter; a module cannot export both under that name (#3604). */
  readonly name?: string;

  constructor(expression: Intrinsic, options?: { name?: string }) {
    if (!isIntrinsic(expression)) {
      throw new Error(
        "new Condition(expression): expression must be a condition intrinsic (Equals, And, Or, Not)",
      );
    }
    this.expression = expression;
    if (options?.name !== undefined) this.name = options.name;
  }
}

/**
 * The name a condition has in the template: its `name` option, else the
 * logical name discovery gave it (the export name).
 */
export function conditionName(condition: Condition, entityNames?: Map<unknown, string>): string {
  return condition.name ?? entityNames?.get(condition) ?? getLogicalName(condition);
}

/**
 * Type guard for the `Condition` declarable. Duck-typed on `entityType`
 * rather than `instanceof` so a lexicon built against a separate copy of
 * `@intentius/chant` still matches (the #1137 convention).
 */
export function isCondition(value: unknown): value is Condition {
  return isDeclarable(value) && value.entityType === CONDITION_ENTITY_TYPE;
}
