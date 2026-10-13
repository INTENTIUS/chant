/**
 * CloudFormation template mapping.
 *
 * A `Mapping` declarable is lifted into the template's `Mappings` section by
 * the serializer, the way `Condition` is lifted into `Conditions`. Read a
 * value from it with `FindInMap(mapping, topLevelKey, secondLevelKey)`.
 */

import { DECLARABLE_MARKER, isDeclarable, type Declarable } from "@intentius/chant/declarable";
import { getLogicalName } from "@intentius/chant/utils";

export const MAPPING_ENTITY_TYPE = "AWS::CloudFormation::Mapping";

export class Mapping implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = MAPPING_ENTITY_TYPE;
  /** Top-level key -> second-level key -> value. */
  readonly map: Record<string, Record<string, unknown>>;
  /** The mapping's key in the template's `Mappings`, when it is not the
   * export name. */
  readonly name?: string;

  constructor(map: Record<string, Record<string, unknown>>, options?: { name?: string }) {
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      throw new Error("new Mapping(map): map must be an object of top-level keys to objects of second-level keys");
    }
    this.map = map;
    if (options?.name !== undefined) this.name = options.name;
  }
}

/** Type guard for the `Mapping` declarable, duck-typed on `entityType` (#1137). */
export function isMapping(value: unknown): value is Mapping {
  return isDeclarable(value) && value.entityType === MAPPING_ENTITY_TYPE;
}

/** The name a mapping has in the template: its `name` option, else its logical name. */
export function mappingName(mapping: Mapping): string {
  return mapping.name ?? getLogicalName(mapping);
}
