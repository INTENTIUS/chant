/**
 * Cedar lexicon serializer.
 *
 * Emits two views of the same policy set:
 *
 * - `.cedar` policy text — the primary output, and the surface every Cedar
 *   evaluator reads (AVP, cedar-agent, an embedded `cedar-wasm`).
 * - the Cedar JSON policy format — a second file, written alongside, and the
 *   parse source for import (#1653). It is produced by handing the emitted
 *   `.cedar` text back to `cedar-wasm`, so what lands on disk is whatever
 *   Cedar itself says that text means. Deriving it from the in-memory model
 *   instead is what shipped first, and it wrote `when` bodies as
 *   `{ "__expr": "<text>" }` — a key Cedar's JSON grammar does not have, which
 *   every Cedar tool rejects with `unknown variant '__expr'`.
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
import { policyToJson, splitPolicySet, templateToJson, type PolicyJson } from "./spec/wasm";

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

/**
 * One policy, as `.cedar` text.
 *
 * Exported because the AVP embedding (#1652) needs exactly this string and
 * nothing else — `AWS::VerifiedPermissions::Policy` carries its policy as
 * `Definition.Static.Statement`, a single Cedar policy rather than a set. Two
 * renderers would be two dialects; there is one.
 */
export function renderPolicyText(id: string, props: Record<string, unknown>): string {
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

/** The JSON policy-set envelope, exactly as `cedar-wasm` accepts it. */
export interface CedarPolicySetJSON {
  staticPolicies: Record<string, PolicyJson>;
  templates: Record<string, PolicyJson>;
  templateLinks: unknown[];
}

/**
 * Build the JSON companion from the emitted `.cedar` text.
 *
 * Two things fall out of going through the module rather than around it. The
 * condition bodies become real expression trees, which is the whole reason the
 * file is worth writing; and a policy carrying a `?principal`/`?resource` slot
 * lands under `templates` rather than `staticPolicies`, because Cedar — not
 * this serializer — is what decides which one it is.
 *
 * Ids come from each policy's own `@id`, not from the emission order, so the
 * keys here cannot drift from the annotations in the text beside them.
 */
export function policySetJSON(text: string): { doc?: CedarPolicySetJSON; error?: string } {
  const parts = splitPolicySet(text);
  if (!parts.ok) return { error: parts.error };

  const doc: CedarPolicySetJSON = { staticPolicies: {}, templates: {}, templateLinks: [] };

  const collect = (
    sources: string[],
    convert: (source: string) => ReturnType<typeof policyToJson>,
    into: Record<string, PolicyJson>,
    fallbackPrefix: string,
  ): string | undefined => {
    for (const [index, source] of sources.entries()) {
      const converted = convert(source);
      if (!converted.ok) return converted.error;
      const id = converted.value.annotations?.id;
      into[typeof id === "string" && id.length > 0 ? id : `${fallbackPrefix}${index}`] = converted.value;
    }
    return undefined;
  };

  const policyError = collect(parts.value.policies, policyToJson, doc.staticPolicies, "policy");
  if (policyError) return { error: policyError };

  const templateError = collect(parts.value.templates, templateToJson, doc.templates, "template");
  if (templateError) return { error: templateError };

  return { doc };
}

// ── The shared policy model ───────────────────────────────────────

/** One declared policy, resolved: its chant name, its Cedar id, and its walked props. */
export interface CedarPolicyRecord {
  /** The chant entity name — the export name on the `*.ts` file. */
  name: string;
  /** The Cedar policy id, as it appears in `@id(…)`. */
  id: string;
  /** Props with references resolved, ready for either renderer. */
  props: Record<string, unknown>;
}

/**
 * The Cedar id for a policy: an explicit `annotations.id` when the author gave
 * one, else derived from the logical name.
 *
 * This is the only rule that links a chant entity to a policy in a live AVP
 * store (#1652) — the observation resolves the same id from the same props and
 * matches it against the `@id` annotation the statement carries. Two copies of
 * this rule would be a mapping that drifts silently, so there is one.
 */
export function resolvePolicyId(logicalName: string, props: Record<string, unknown>): string {
  const explicit = isRecord(props.annotations) ? props.annotations.id : undefined;
  return typeof explicit === "string" && explicit.length > 0
    ? explicit
    : policyIdFromLogicalName(logicalName);
}

/**
 * Every `Cedar::Policy` in a build, with references walked and ids resolved.
 *
 * The serializer's own first pass, exported so the AVP embedding (#1652)
 * renders from the same model rather than re-deriving it.
 */
export function cedarPolicyRecords(entities: Map<string, Declarable>): CedarPolicyRecord[] {
  // Reverse map first: walkValue resolves a Declarable reference by identity,
  // so every entity has to be known before any of them is walked.
  const entityNames = new Map<Declarable, string>();
  for (const [name, entity] of entities) {
    entityNames.set(entity, name);
  }

  const records: CedarPolicyRecord[] = [];
  for (const [name, entity] of entities) {
    if (isPropertyDeclarable(entity)) continue;
    if (entity.entityType !== CEDAR_POLICY_TYPE) continue;

    const props = walkValue(getProps(entity), entityNames, cedarVisitor) as Record<string, unknown>;
    records.push({ name, id: resolvePolicyId(name, props), props });
  }
  return records;
}

// ── Serializer ────────────────────────────────────────────────────

export const cedarSerializer: Serializer = {
  name: "cedar",
  rulePrefix: "CED",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const policyText: string[] = [];

    for (const { id, props } of cedarPolicyRecords(entities)) {
      policyText.push(renderPolicyText(id, props));
    }

    if (policyText.length === 0) return "";

    const primary = policyText.join("\n\n") + "\n";
    const { doc, error } = policySetJSON(primary);

    // A policy set Cedar cannot read is a real defect, but it is the lint and
    // post-synth surface's to report (#1651) — the text is still the artifact
    // every evaluator consumes, so it is emitted either way, with the module's
    // own message carried out as a build warning rather than swallowed.
    if (!doc) {
      return {
        primary,
        warnings: [`cedar: the emitted policy text did not parse, so ${CEDAR_JSON_FILENAME} was not written — ${error}`],
      };
    }

    return {
      primary,
      files: { [CEDAR_JSON_FILENAME]: JSON.stringify(doc, null, 2) + "\n" },
    };
  },
};
