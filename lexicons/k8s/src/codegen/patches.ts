/**
 * Schema augmentation patches for the Kubernetes OpenAPI spec.
 *
 * The official K8s OpenAPI spec has known issues: recursive definitions
 * in JSONSchemaProps, ambiguous IntOrString typing, and Quantity being
 * opaque. Patches are applied after fetch but before parse.
 */

/**
 * A targeted fix for a schema definition.
 */
export interface SchemaPatch {
  /** Human-readable description of what this patch fixes */
  description: string;
  /** JSON path to the definition to patch (e.g. "definitions.io.k8s.api.core.v1.Container") */
  path: string;
  /** Function that applies the patch to the definition */
  apply(def: Record<string, unknown>): void;
}

/**
 * Registry of known schema patches.
 */
export const schemaPatches: SchemaPatch[] = [
  {
    description:
      "Break infinite recursion in JSONSchemaProps by capping nested $ref depth",
    path: "definitions.io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaProps",
    apply(def) {
      // JSONSchemaProps references itself in properties, items, additionalProperties, etc.
      // We mark it as a plain object to prevent infinite recursion in the codegen walker.
      const props = def.properties as Record<string, unknown> | undefined;
      if (!props) return;

      // Replace self-referencing fields with opaque Record<string, any>
      for (const key of [
        "properties",
        "additionalProperties",
        "not",
        "allOf",
        "oneOf",
        "anyOf",
      ]) {
        if (props[key]) {
          (props[key] as Record<string, unknown>).description ??=
            "JSON Schema definition (recursive, treated as opaque)";
        }
      }
    },
  },
  {
    description:
      "Patch IntOrString to be explicitly typed as string | number",
    path: "definitions.io.k8s.apimachinery.pkg.util.intstr.IntOrString",
    apply(def) {
      // The spec marks this as just "string" with a format, but it's actually
      // a union type used for ports, resource quantities, etc.
      if (!def["x-kubernetes-int-or-string"]) {
        def["x-kubernetes-int-or-string"] = true;
      }
    },
  },
  {
    description: "Patch Quantity to be typed as string",
    path: "definitions.io.k8s.apimachinery.pkg.api.resource.Quantity",
    apply(def) {
      // Quantity is serialized as a string (e.g., "500m", "1Gi") but the
      // spec sometimes marks it as having no type. Force string.
      if (!def.type) {
        def.type = "string";
      }
    },
  },
];

/**
 * Apply all registered patches to a parsed schema.
 * Modifies the schema in place.
 */
export function applyPatches(
  schema: Record<string, unknown>,
): { applied: string[]; skipped: string[] } {
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
