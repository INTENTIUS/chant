/**
 * IR intrinsic scanning utilities.
 *
 * Generic recursive walkers that scan the import IR value trees for
 * intrinsic markers and dependency references.
 */

import type { TemplateIR } from "./parser";

/**
 * Check if a value tree contains an intrinsic with the given name.
 * Looks for `{ __intrinsic: name }` objects recursively.
 */
export function hasIntrinsicInValue(value: unknown, name: string): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasIntrinsicInValue(item, name));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.__intrinsic === name) {
      return true;
    }
    return Object.values(obj).some((v) => hasIntrinsicInValue(v, name));
  }

  return false;
}

/**
 * Check if any resource in the IR uses a given intrinsic.
 */
export function irUsesIntrinsic(ir: TemplateIR, name: string): boolean {
  for (const resource of ir.resources) {
    if (hasIntrinsicInValue(resource.properties, name)) {
      return true;
    }
  }
  return false;
}

/**
 * Collect dependency references from a value tree.
 *
 * @param value - The value tree to scan
 * @param isDependency - Given an object, returns a logical ID if it represents
 *   a dependency, or null otherwise. Each lexicon provides its own predicate.
 */
export function collectDependencies(
  value: unknown,
  isDependency: (obj: Record<string, unknown>) => string | null,
): Set<string> {
  const deps = new Set<string>();
  collectDepsRecursive(value, isDependency, deps);
  return deps;
}

function collectDepsRecursive(
  value: unknown,
  isDependency: (obj: Record<string, unknown>) => string | null,
  deps: Set<string>,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectDepsRecursive(item, isDependency, deps);
    }
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const dep = isDependency(obj);
    if (dep !== null) {
      deps.add(dep);
    } else {
      for (const v of Object.values(obj)) {
        collectDepsRecursive(v, isDependency, deps);
      }
    }
  }
}
