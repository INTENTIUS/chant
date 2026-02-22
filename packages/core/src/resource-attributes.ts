/**
 * Utilities for resolving resource-level attributes (DependsOn, Condition, etc.).
 *
 * Shared by lexicon serializers — the DependsOn resolution logic converts
 * Declarable object references to logical names.
 */

import type { Declarable } from "./declarable";

/**
 * Resolve a DependsOn value (Declarable, string, or mixed array) into
 * an array of logical resource names.
 *
 * - Strings pass through as-is (user-specified logical names)
 * - Declarable objects are looked up in the entityNames map
 * - Unknown values emit a console warning and are skipped
 */
export function resolveDependsOn(
  deps: unknown,
  entityNames: Map<Declarable, string>,
  resourceName: string,
): string[] {
  const items = Array.isArray(deps) ? deps : [deps];
  const resolved: string[] = [];

  for (const dep of items) {
    if (typeof dep === "string") {
      resolved.push(dep);
    } else if (typeof dep === "object" && dep !== null && "entityType" in dep) {
      const depName = entityNames.get(dep as Declarable);
      if (depName) {
        resolved.push(depName);
      } else {
        console.warn(
          `[chant] warning: DependsOn in "${resourceName}" references a declarable not found in the build — is the target resource exported?`,
        );
      }
    }
  }

  return resolved;
}
