/**
 * Schema augmentation patches for GitHub Actions Workflow JSON Schema.
 */

export interface SchemaPatch {
  description: string;
  path: string;
  apply(def: Record<string, unknown>): void;
}

/**
 * Registry of known schema patches.
 * Currently empty — the SchemaStore workflow schema is well-maintained.
 */
export const schemaPatches: SchemaPatch[] = [];

/**
 * Apply all registered patches to a parsed schema.
 */
export function applyPatches(schema: Record<string, unknown>): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const patch of schemaPatches) {
    const segments = patch.path.split(".");
    let target: Record<string, unknown> | undefined = schema;

    for (const segment of segments) {
      if (target && typeof target === "object" && segment in target) {
        target = target[segment] as Record<string, unknown>;
      } else {
        target = undefined;
        break;
      }
    }

    if (target) {
      patch.apply(target);
      applied.push(patch.description);
    } else {
      skipped.push(`${patch.description} (path "${patch.path}" not found)`);
    }
  }

  return { applied, skipped };
}
