import type { Declarable } from "../declarable";
import { AttrRef } from "../attrref";
import { LOGICAL_NAME_SYMBOL, getAttributes } from "../utils";

/**
 * Resolves all AttrRef instances in a collection of entities
 * Sets logical names on entities and resolves parent references in AttrRefs
 *
 * @param entities - Map of export name to Declarable entity
 * @throws {Error} If an AttrRef parent cannot be found in the entities collection
 */
export function resolveAttrRefs(entities: Map<string, Declarable>): void {
  // First pass: Set logical names on all entities
  for (const [name, entity] of entities.entries()) {
    (entity as unknown as Record<symbol, unknown>)[LOGICAL_NAME_SYMBOL] = name;
  }

  // Second pass: Resolve all AttrRef instances
  for (const [name, entity] of entities.entries()) {
    const attributes = getAttributes(entity);

    for (const attrName of attributes) {
      const attrRef = (entity as unknown as Record<string, unknown>)[attrName];

      if (attrRef instanceof AttrRef) {
        const parent = attrRef.parent.deref();

        if (!parent) {
          throw new Error(
            `Cannot resolve AttrRef on "${name}.${attrName}": parent has been garbage collected`
          );
        }

        // Find the parent entity in the entities map
        let parentLogicalName: string | undefined;

        for (const [entityName, entityValue] of entities.entries()) {
          if (entityValue === parent) {
            parentLogicalName = entityName;
            break;
          }
        }

        if (!parentLogicalName) {
          throw new Error(
            `Cannot resolve AttrRef on "${name}.${attrName}": parent entity not found in entities collection`
          );
        }

        attrRef._setLogicalName(parentLogicalName);
      }
    }
  }
}
