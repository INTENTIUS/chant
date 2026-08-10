/**
 * Cedar lexicon serializer.
 *
 * Emits two views of the same policy set:
 *
 * - `.cedar` policy text — the primary output, and the surface every Cedar
 *   evaluator reads (AVP, cedar-agent, an embedded `cedar-wasm`).
 * - the Cedar JSON policy format — a second file, written alongside. It is
 *   also the parse source for import (#1653), which is why it is produced
 *   from the same structured model rather than by re-parsing the text.
 *
 * The entity model this serializer reads is hand-shaped for now: one
 * `Cedar::Policy` entity type whose `props` carry an effect, three scope
 * constraints, and optional `when`/`unless` guards. Schema-driven codegen
 * (#1650) generates typed classes onto exactly this shape, so nothing here
 * changes when it lands — the guards become typed expressions rather than
 * the opaque Cedar-expression strings they are today.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";

// ── The policy entity model ───────────────────────────────────────

/** The `entityType` this serializer reads. */
export const CEDAR_POLICY_TYPE = "Cedar::Policy";

/** Filename of the JSON policy-set companion to the primary `.cedar` output. */
export const CEDAR_JSON_FILENAME = "policies.cedar.json";

/** A Cedar policy either permits or forbids; there is no third effect. */
export type CedarEffect = "permit" | "forbid";

/**
 * One scope position (`principal`, `action`, `resource`).
 *
 * `{}` is "any" — the unconstrained form Cedar writes as a bare variable.
 * The constrained forms mirror the grammar: `== E`, `in E`, `in [E, …]`,
 * `is T`, and `is T in E`.
 */
export type CedarScope =
  | Record<string, never>
  | { eq: string; in?: never; is?: never }
  | { in: string | string[]; eq?: never; is?: never }
  | { is: string; in?: string | string[]; eq?: never };

/** The `props` of a `Cedar::Policy` entity. */
export interface CedarPolicyProps {
  /** Defaults to `permit` when omitted. */
  effect?: CedarEffect;
  /** Defaults to unconstrained (`{}`) when omitted. */
  principal?: CedarScope;
  /** Defaults to unconstrained (`{}`) when omitted. */
  action?: CedarScope;
  /** Defaults to unconstrained (`{}`) when omitted. */
  resource?: CedarScope;
  /** Cedar expression strings, each emitted as its own `when { … }` clause. */
  when?: string[];
  /** Cedar expression strings, each emitted as its own `unless { … }` clause. */
  unless?: string[];
  /**
   * Emitted as `@key("value")` above the policy. An explicit `id` wins over
   * the one derived from the logical name.
   */
  annotations?: Record<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProps(entity: Declarable): Record<string, unknown> {
  if (isResourceDeclarable(entity) && isRecord(entity.props)) {
    return entity.props;
  }
  return {};
}

/** Escape a string for a double-quoted Cedar literal. */
function escapeCedarString(value: string): string {
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
 * Split an entity UID (`Namespace::Type::"id"`) into its JSON parts.
 *
 * A value that is not in UID form is carried through as a bare type with an
 * empty id rather than dropped — validating that it parses is the wasm
 * validator's job (#1651), not the serializer's.
 */
function entityUid(ref: string): { type: string; id: string } {
  const match = /^(.+)::"(.*)"$/.exec(ref.trim());
  if (match) return { type: match[1], id: match[2] };
  return { type: ref.trim(), id: "" };
}

// ── Walker visitor ────────────────────────────────────────────────

/**
 * Cedar has no intrinsic function syntax, so references collapse to the text
 * a policy would name them by. Property names pass through verbatim.
 */
const cedarVisitor: SerializerVisitor = {
  attrRef: (logicalName, attribute) => `${logicalName}.${attribute}`,
  resourceRef: (logicalName) => logicalName,
  propertyDeclarable: (entity, walk) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(getProps(entity))) {
      if (key === "entityType" || key === "lexicon") continue;
      if (value === undefined) continue;
      out[key] = walk(value);
    }
    return out;
  },
};

// ── Cedar policy text ─────────────────────────────────────────────

function refText(value: unknown): string {
  return String(value);
}

/** `principal`, `principal == User::"alice"`, `action in [ … ]`, `resource is Photo`. */
function renderScope(variable: string, scope: unknown): string {
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

function conditionStrings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(refText);
  return [refText(value)];
}

function renderPolicyText(id: string, props: Record<string, unknown>): string {
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

  for (const clause of conditionStrings(props.when)) {
    lines.push(`when { ${clause} }`);
  }
  for (const clause of conditionStrings(props.unless)) {
    lines.push(`unless { ${clause} }`);
  }

  return lines.join("\n") + ";";
}

// ── Cedar JSON policy format ──────────────────────────────────────

function scopeJSON(scope: unknown): Record<string, unknown> {
  if (!isRecord(scope)) return { op: "All" };

  const inValue = scope.in;
  const inJSON = (): Record<string, unknown> =>
    Array.isArray(inValue)
      ? { entities: inValue.map((entry) => entityUid(refText(entry))) }
      : { entity: entityUid(refText(inValue)) };

  if (typeof scope.is === "string") {
    const out: Record<string, unknown> = { op: "is", entity_type: scope.is };
    if (inValue !== undefined) out.in = inJSON();
    return out;
  }
  if (scope.eq !== undefined) {
    return { op: "==", entity: entityUid(refText(scope.eq)) };
  }
  if (inValue !== undefined) {
    return { op: "in", ...inJSON() };
  }
  return { op: "All" };
}

/**
 * Condition bodies are Cedar expression ASTs in the JSON format, and the
 * model carries expression *text* until #1650 makes them typed. `__expr` is
 * Cedar's own escape for exactly that — an expression given as source rather
 * than as a tree — so the file stays machine-readable instead of inventing a
 * private key nothing downstream knows.
 */
function conditionsJSON(props: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const clause of conditionStrings(props.when)) {
    out.push({ kind: "when", body: { __expr: clause } });
  }
  for (const clause of conditionStrings(props.unless)) {
    out.push({ kind: "unless", body: { __expr: clause } });
  }
  return out;
}

function renderPolicyJSON(id: string, props: Record<string, unknown>): Record<string, unknown> {
  const annotations: Record<string, string> = { id };
  if (isRecord(props.annotations)) {
    for (const [key, value] of Object.entries(props.annotations)) {
      if (key === "id" || value === undefined || value === null) continue;
      annotations[key] = refText(value);
    }
  }

  return {
    effect: props.effect === "forbid" ? "forbid" : "permit",
    principal: scopeJSON(props.principal),
    action: scopeJSON(props.action),
    resource: scopeJSON(props.resource),
    conditions: conditionsJSON(props),
    annotations,
  };
}

// ── Serializer ────────────────────────────────────────────────────

export const cedarSerializer: Serializer = {
  name: "cedar",
  rulePrefix: "CED",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    // Reverse map first: walkValue resolves a Declarable reference by identity,
    // so every entity has to be known before any of them is walked.
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    const policyText: string[] = [];
    const staticPolicies: Record<string, unknown> = {};

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;
      if (entity.entityType !== CEDAR_POLICY_TYPE) continue;

      const props = walkValue(getProps(entity), entityNames, cedarVisitor) as Record<string, unknown>;

      const explicitId = isRecord(props.annotations) ? props.annotations.id : undefined;
      const id = typeof explicitId === "string" && explicitId.length > 0
        ? explicitId
        : policyIdFromLogicalName(name);

      policyText.push(renderPolicyText(id, props));
      staticPolicies[id] = renderPolicyJSON(id, props);
    }

    if (policyText.length === 0) return "";

    return {
      primary: policyText.join("\n\n") + "\n",
      files: {
        [CEDAR_JSON_FILENAME]:
          JSON.stringify({ staticPolicies, templates: {}, templateLinks: [] }, null, 2) + "\n",
      },
    };
  },
};
