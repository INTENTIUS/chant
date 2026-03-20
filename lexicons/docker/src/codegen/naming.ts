/**
 * Naming strategy for Docker lexicon entities.
 *
 * Converts Docker/Compose entity type names to TypeScript class names.
 */

/** Map entityType → TypeScript class name */
const ENTITY_TYPE_TO_TS_NAME: Record<string, string> = {
  "Docker::Compose::Service": "Service",
  "Docker::Compose::Volume": "Volume",
  "Docker::Compose::Network": "Network",
  "Docker::Compose::Config": "DockerConfig",
  "Docker::Compose::Secret": "DockerSecret",
  "Docker::Dockerfile": "Dockerfile",
};

/** Map TypeScript class name → entityType */
const TS_NAME_TO_ENTITY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_TYPE_TO_TS_NAME).map(([k, v]) => [v, k]),
);

/**
 * Convert a Docker entity type name to a TypeScript class name.
 * e.g. "Docker::Compose::Service" → "Service"
 */
export function entityTypeToTsName(entityType: string): string {
  return ENTITY_TYPE_TO_TS_NAME[entityType] ?? entityType.split("::").pop() ?? entityType;
}

/**
 * Convert a TypeScript class name back to an entity type.
 */
export function tsNameToEntityType(tsName: string): string | undefined {
  return TS_NAME_TO_ENTITY_TYPE[tsName];
}

/**
 * All known Docker entity types, in declaration order.
 */
export const ALL_ENTITY_TYPES = Object.keys(ENTITY_TYPE_TO_TS_NAME);

/**
 * Check whether an entity type is a Compose resource.
 */
export function isComposeType(entityType: string): boolean {
  return entityType.startsWith("Docker::Compose::");
}

/**
 * Check whether an entity type is the Dockerfile resource.
 */
export function isDockerfileType(entityType: string): boolean {
  return entityType === "Docker::Dockerfile";
}
