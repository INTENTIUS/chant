/**
 * Schema augmentation patches for GitLab CI JSON Schema.
 *
 * The official GitLab CI schema sometimes has gaps, missing properties,
 * or incorrect types. Patches are applied after fetch but before parse
 * to fix these issues.
 */

/**
 * A targeted fix for a schema definition.
 */
export interface SchemaPatch {
  /** Human-readable description of what this patch fixes */
  description: string;
  /** JSON path to the definition to patch (e.g. "definitions.job_template") */
  path: string;
  /** Function that applies the patch to the definition */
  apply(def: Record<string, unknown>): void;
}

/**
 * Registry of known schema patches.
 */
export const schemaPatches: SchemaPatch[] = [
  {
    description: "Add 'pages' property type to job_template if missing",
    path: "definitions.job_template",
    apply(def) {
      const props = def.properties as Record<string, unknown> | undefined;
      if (props && !props.pages) {
        props.pages = {
          description: "GitLab Pages configuration for publishing static sites.",
          oneOf: [
            { type: "object", properties: { publish: { type: "string" } } },
            { type: "boolean" },
          ],
        };
      }
    },
  },
  {
    description: "Add 'manual_confirmation' property to job_template if missing",
    path: "definitions.job_template",
    apply(def) {
      const props = def.properties as Record<string, unknown> | undefined;
      if (props && !props.manual_confirmation) {
        props.manual_confirmation = {
          type: "string",
          description: "Confirmation message displayed when a manual job is triggered.",
        };
      }
    },
  },
  {
    description: "Add 'inputs' property to job_template if missing",
    path: "definitions.job_template",
    apply(def) {
      const props = def.properties as Record<string, unknown> | undefined;
      if (props && !props.inputs) {
        props.inputs = {
          type: "object",
          description: "Input parameters for CI/CD component jobs.",
          additionalProperties: true,
        };
      }
    },
  },
];

/**
 * Apply all registered patches to a parsed schema.
 * Modifies the schema in place.
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
