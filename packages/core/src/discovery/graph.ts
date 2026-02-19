import type { Declarable } from "../declarable";
import { isDeclarable } from "../declarable";
import { AttrRef } from "../attrref";

/**
 * Builds a dependency graph from a collection of entities
 * @param entities - Map of export name to Declarable entity
 * @returns Map of entity name to set of entity names it depends on
 */
export function buildDependencyGraph(
  entities: Map<string, Declarable>
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  // Initialize graph with all entity names
  for (const name of entities.keys()) {
    graph.set(name, new Set<string>());
  }

  // Build reverse lookup: entity -> name
  const entityToName = new Map<Declarable, string>();
  for (const [name, entity] of entities.entries()) {
    entityToName.set(entity, name);
  }

  // Find dependencies for each entity
  for (const [name, entity] of entities.entries()) {
    const dependencies = graph.get(name)!;
    const visited = new Set<unknown>();
    // Scan the root entity's properties
    scanProperties(entity, entities, entityToName, dependencies, visited, entity);
  }

  return graph;
}

/**
 * Scans properties of an object for dependencies
 */
function scanProperties(
  obj: object,
  entities: Map<string, Declarable>,
  entityToName: Map<Declarable, string>,
  dependencies: Set<string>,
  visited: Set<unknown>,
  rootEntity: Declarable
): void {
  // Mark this object as visited (but not if it's a Declarable, we'll handle that in findDependencies)
  if (!isDeclarable(obj) && !visited.has(obj)) {
    visited.add(obj);
  }

  // Recurse into arrays
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findDependencies(item, entities, entityToName, dependencies, visited, rootEntity);
    }
    return;
  }

  // Recurse into object properties
  for (const prop in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) {
      const propValue = (obj as Record<string, unknown>)[prop];
      findDependencies(
        propValue,
        entities,
        entityToName,
        dependencies,
        visited,
        rootEntity
      );
    }
  }
}

/**
 * Recursively finds all dependencies in a value
 */
function findDependencies(
  value: unknown,
  entities: Map<string, Declarable>,
  entityToName: Map<Declarable, string>,
  dependencies: Set<string>,
  visited: Set<unknown>,
  rootEntity: Declarable
): void {
  // Avoid infinite recursion on circular references
  if (value === null || value === undefined) {
    return;
  }

  // For primitives, nothing to do
  if (typeof value !== "object") {
    return;
  }

  // Check if this is an AttrRef
  if (value instanceof AttrRef) {
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    const parent = value.parent.deref();
    if (parent && isDeclarable(parent) && parent !== rootEntity) {
      const parentName = entityToName.get(parent);
      if (parentName) {
        dependencies.add(parentName);
      }
    }
    return;
  }

  // Check if this is a Declarable entity reference
  if (isDeclarable(value)) {
    // If this is the root entity itself, skip it but don't mark as visited
    // so we can detect it if referenced again (self-reference)
    if (value === rootEntity) {
      if (visited.has(value)) {
        // We've seen this self-reference before, record it as a dependency
        const referencedName = entityToName.get(value);
        if (referencedName) {
          dependencies.add(referencedName);
        }
        return;
      }
      // First time seeing the root entity, mark as visited and continue scanning
      visited.add(value);
      scanProperties(value, entities, entityToName, dependencies, visited, rootEntity);
      return;
    }

    // It's a different Declarable entity - record as dependency
    const referencedName = entityToName.get(value);
    if (referencedName) {
      dependencies.add(referencedName);
    }
    // Don't recurse into other declarable entities
    return;
  }

  // Check if we've already visited this object
  if (visited.has(value)) {
    return;
  }

  // Recurse into the object's properties
  scanProperties(value, entities, entityToName, dependencies, visited, rootEntity);
}
