/**
 * Shared helpers for the render post-synth checks. Not a check itself, so the
 * generated barrel skips it (the scanner only picks up exported PostSynthChecks).
 */

import { isServiceEntityType } from "../../catalog";

/**
 * Read an entity or property's constructor props. Nested Declarables
 * (WebServiceDetails, Image, ServiceDisk) stash their args under a
 * non-enumerable `props`; a plain inline object carries them directly. Handle
 * both so a check behaves the same whether the user authored
 * `serviceDetails: { runtime }` or `serviceDetails: new WebServiceDetails({ runtime })`.
 */
export function readProps(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const nested = (value as { props?: unknown }).props;
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
    return value as Record<string, unknown>;
  }
  return {};
}

/** The entityType of a declarable, or undefined. */
export function entityTypeOf(value: unknown): string | undefined {
  return (value as { entityType?: string } | undefined)?.entityType;
}

/** True when the entity is one of the five service kinds. */
export function isService(value: unknown): boolean {
  return isServiceEntityType(entityTypeOf(value));
}

/** The short kind (`WebService`) from an entity type, for messages. */
export function kindOf(value: unknown): string {
  const t = entityTypeOf(value) ?? "";
  return t.slice(t.lastIndexOf("::") + 2);
}
