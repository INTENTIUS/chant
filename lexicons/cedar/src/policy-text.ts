/**
 * Cedar policy-text rendering, shared by the `.cedar` serializer, the AVP
 * statement renderer, and the dogwood dialect's `.dw` leg.
 *
 * Upstream's dogwood policy grammar is Cedar's shape — `annotation* effect
 * "(" scope ")" cond* ";"` — and only the `cond` rule differs, gaining
 * `guardrails { … }` and `temporal { … }` forms. So everything above the first
 * clause is common, and it lives here rather than being copied into
 * `./dogwood/serialize.ts`, where a change to how a scope constraint is
 * written would have had to be made twice.
 *
 * `resolvePolicyId` is here for the same reason it was extracted from
 * `serialize()` by #1652: it is the only rule linking a chant entity to a
 * policy id, the AVP observation matches against it, and the `.dw` leg has to
 * derive ids the same way the `.cedar` leg does. One copy, three callers.
 *
 * This module is a leaf on purpose: `./serializer.ts` and `./dogwood/*` both
 * import it, and neither imports the other's rendering.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";

/** A plain object — not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `props` of a resource-kind Declarable, or `{}` for anything else. */
export function getProps(entity: Declarable): Record<string, unknown> {
  if (isResourceDeclarable(entity) && isRecord(entity.props)) {
    return entity.props;
  }
  return {};
}

/** Escape a string for a double-quoted Cedar literal. */
export function escapeCedarString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Derive a policy id from a logical name: `allowAdminRead` → `allow-admin-read`.
 * Cedar ids are free-form strings; kebab-case keeps them readable in the
 * `@id` annotation and stable across a rename-free refactor.
 */
export function policyIdFromLogicalName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * The Cedar id for a policy: an explicit `annotations.id` when the author gave
 * one, else derived from the logical name.
 *
 * This is the only rule that links a chant entity to a policy in a live AVP
 * store (#1652) — the observation resolves the same id from the same props and
 * matches it against the `@id` annotation the statement carries — and it is
 * also what gives a `.dw` policy the id its `.cedar` sibling would have had.
 * Two copies of this rule would be a mapping that drifts silently.
 */
export function resolvePolicyId(logicalName: string, props: Record<string, unknown>): string {
  const explicit = isRecord(props.annotations) ? props.annotations.id : undefined;
  return typeof explicit === "string" && explicit.length > 0
    ? explicit
    : policyIdFromLogicalName(logicalName);
}

function refText(value: unknown): string {
  return String(value);
}

/** `principal`, `principal == User::"alice"`, `action in [ … ]`, `resource is Photo`. */
export function renderScope(variable: string, scope: unknown): string {
  if (!isRecord(scope)) return variable;

  const parts = [variable];
  if (typeof scope.is === "string") parts.push(`is ${scope.is}`);
  if (scope.eq !== undefined) parts.push(`== ${refText(scope.eq)}`);
  if (scope.in !== undefined) {
    parts.push(
      Array.isArray(scope.in)
        ? `in [${scope.in.map(refText).join(", ")}]`
        : `in ${refText(scope.in)}`,
    );
  }
  return parts.join(" ");
}

/** A `when`/`unless` prop as a list of clause bodies — one string, or several. */
export function conditionStrings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(refText);
  return [refText(value)];
}

/**
 * Everything above the first clause: the annotations, the effect, and the
 * three scope positions.
 */
export function renderPolicyHead(id: string, props: Record<string, unknown>): string[] {
  const lines: string[] = [];

  // @id first, then the author's own annotations in declaration order.
  const annotations = isRecord(props.annotations) ? props.annotations : {};
  lines.push(`@id("${escapeCedarString(id)}")`);
  for (const [key, value] of Object.entries(annotations)) {
    if (key === "id" || value === undefined || value === null) continue;
    lines.push(`@${key}("${escapeCedarString(refText(value))}")`);
  }

  const effect = props.effect === "forbid" ? "forbid" : "permit";
  lines.push(`${effect} (`);
  lines.push(`  ${renderScope("principal", props.principal)},`);
  lines.push(`  ${renderScope("action", props.action)},`);
  lines.push(`  ${renderScope("resource", props.resource)}`);
  lines.push(")");

  return lines;
}
