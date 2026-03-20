/**
 * Manual overrides for upstream Docker spec quirks.
 *
 * These patches adjust entity names, property types, or descriptions
 * where the upstream spec is ambiguous, incorrect, or overly broad.
 */

export interface EntityPatch {
  /** Override entity description */
  description?: string;
  /** Override specific property types */
  propertyOverrides?: Record<string, { type?: string; description?: string }>;
  /** Properties to exclude from type generation */
  excludeProperties?: string[];
}

/**
 * Patches keyed by entity typeName.
 */
export const ENTITY_PATCHES: Record<string, EntityPatch> = {
  "Docker::Compose::Service": {
    propertyOverrides: {
      // The spec allows both string and object forms for these — normalize to object
      depends_on: {
        description: "Service dependencies (may be string[] or condition map)",
      },
      // healthcheck interval/timeout are duration strings in Docker syntax
      healthcheck: {
        description: "Health check configuration with Docker duration strings (e.g., '30s', '1m30s')",
      },
    },
  },

  "Docker::Dockerfile": {
    propertyOverrides: {
      // Multi-stage builds use stages array
      stages: {
        description: "Multi-stage build stages — each stage has its own FROM and instructions",
      },
    },
  },
};
