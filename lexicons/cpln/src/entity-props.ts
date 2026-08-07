/**
 * Read an entity's authored props regardless of representation, and walk the
 * shapes cpln's checks keep needing.
 *
 * Real runtime instances (`createResource`/`createProperty`) keep authored
 * props under a non-enumerable `.props` — enumerating the instance yields its
 * `AttrRef`s, not its inputs. Plain objects (test fixtures, parsed manifests)
 * carry props as own fields. Every cpln consumer goes through here so both
 * shapes behave identically.
 *
 * A cpln spec is also nested property declarables all the way down: a
 * `Workload`'s `spec.containers[0].readinessProbe` may be a plain object, a
 * `WorkloadSpecContainersReadinessProbe` instance, or a mix, depending on how
 * the author wrote it. {@link readProp} unwraps at every level so a check can
 * be written against one shape.
 */

import type { Declarable } from "@intentius/chant/declarable";

/** Reserved instance fields core installs; never authored props. */
const RESERVED = new Set(["entityType", "lexicon", "kind", "attributes", "props", "Ref"]);

/** Read an entity's or property declarable's authored props. */
export function propsOf(entity: unknown): Record<string, unknown> {
  if (!entity || typeof entity !== "object") return {};
  const anyEntity = entity as Record<string, unknown>;
  if (anyEntity.props && typeof anyEntity.props === "object" && !Array.isArray(anyEntity.props)) {
    return anyEntity.props as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(anyEntity)) {
    if (RESERVED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Read a named property, unwrapping a nested property declarable. */
export function readProp(source: unknown, key: string): unknown {
  const props = propsOf(source);
  const value = props[key];
  return isDeclarableLike(value) ? propsOf(value) : value;
}

/** Read a nested path, unwrapping declarables at each step. `readPath(w, "spec", "job")`. */
export function readPath(source: unknown, ...keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = readProp(current, key);
  }
  return current;
}

/** Read a property expected to be an array, unwrapping each element. */
export function readArray(source: unknown, ...keys: string[]): unknown[] {
  const value = readPath(source, ...keys);
  if (!Array.isArray(value)) return [];
  return value.map((item) => (isDeclarableLike(item) ? propsOf(item) : item));
}

/** Read a property expected to be a string. */
export function readString(source: unknown, ...keys: string[]): string | undefined {
  const value = readPath(source, ...keys);
  return typeof value === "string" ? value : undefined;
}

/** Read a property expected to be a number. */
export function readNumber(source: unknown, ...keys: string[]): number | undefined {
  const value = readPath(source, ...keys);
  return typeof value === "number" ? value : undefined;
}

/** Read a property expected to be a boolean. */
export function readBoolean(source: unknown, ...keys: string[]): boolean | undefined {
  const value = readPath(source, ...keys);
  return typeof value === "boolean" ? value : undefined;
}

/** A value that carries authored props under `.props` (a declarable instance). */
function isDeclarableLike(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).props === "object"
  );
}

/** Iterate the entities of one cpln kind, yielding `[name, entity]`. */
export function* entitiesOfType(
  entities: Map<string, Declarable>,
  typeName: string,
): Generator<[string, Declarable]> {
  for (const [name, entity] of entities) {
    if (entity.entityType === typeName) yield [name, entity];
  }
}
