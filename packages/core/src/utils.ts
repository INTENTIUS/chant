import type { Declarable } from "./declarable";
import { AttrRef } from "./attrref";

/**
 * Symbol for storing logical names on Declarable entities
 */
export const LOGICAL_NAME_SYMBOL = Symbol.for("chant.logicalName");

/**
 * Duck-type check for AttrRef that survives the dual-package hazard.
 * When npm installs separate copies of @intentius/chant (one for the CLI,
 * one for the lexicon), `instanceof AttrRef` fails across package boundaries.
 */
export function isAttrRefLike(value: unknown): value is AttrRef {
  if (value instanceof AttrRef) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    "parent" in value &&
    "attribute" in value &&
    "_setLogicalName" in value &&
    typeof (value as any).parent === "object" &&
    typeof (value as any).attribute === "string"
  );
}

/**
 * JSON.stringify replacer that sorts object keys for deterministic output.
 */
export function sortedJsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}

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
      if (isAttrRefLike(value)) {
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
