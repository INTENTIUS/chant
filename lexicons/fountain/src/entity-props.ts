/**
 * Read an entity's authored props regardless of representation.
 *
 * Real runtime instances (createResource/createProperty) keep authored
 * props under the non-enumerable `.props` — enumerating the instance
 * yields its AttrRefs, not its inputs. Plain objects (parsed data, test
 * fixtures) carry props as own fields. Every fountain consumer of entity
 * props goes through here so both shapes behave identically.
 */
export function propsOf(entity: unknown): Record<string, unknown> {
  if (!entity || typeof entity !== "object") return {};
  const anyEntity = entity as Record<string, unknown>;
  if (anyEntity.props && typeof anyEntity.props === "object" && !Array.isArray(anyEntity.props)) {
    return anyEntity.props as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(anyEntity)) {
    if (key === "entityType" || key === "lexicon" || key === "kind" || key === "attributes") continue;
    out[key] = value;
  }
  return out;
}
