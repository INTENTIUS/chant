import type { Declarable } from "./declarable";
import { AttrRef } from "./attrref";

/**
 * Symbol for storing logical names on Declarable entities
 */
export const LOGICAL_NAME_SYMBOL = Symbol.for("chant.logicalName");

/**
 * Get all property names that have AttrRef values
 * @param entity - The declarable entity to inspect
 * @returns Array of property names with AttrRef values
 */
export function getAttributes(entity: Declarable): string[] {
  const attributes: string[] = [];
  const obj = entity as unknown as Record<string, unknown>;

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value instanceof AttrRef) {
        attributes.push(key);
      }
    }
  }

  return attributes;
}

/**
 * Get the logical name stored on a Declarable entity
 * @param entity - The declarable entity
 * @returns The logical name
 * @throws {Error} If logical name is not set
 */
export function getLogicalName(entity: Declarable): string {
  const logicalName = (entity as unknown as Record<symbol, unknown>)[LOGICAL_NAME_SYMBOL];

  if (typeof logicalName !== "string") {
    throw new Error(
      `Logical name not set on entity of type "${entity.entityType}"`
    );
  }

  return logicalName;
}
