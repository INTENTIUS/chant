/**
 * Cedar policy parser for `chant import`.
 *
 * Two surfaces come in and one IR goes out:
 *
 * - **`.cedar` policy text** — split by `policySetTextToParts`, then each
 *   policy handed to `policyToJson` (or `templateToJson`, for one carrying a
 *   slot). The Cedar grammar is never touched here; the module owns it.
 * - **the JSON policy-set envelope** the serializer writes beside the text —
 *   `{ staticPolicies, templates, templateLinks }`, whose values are already
 *   in Cedar's JSON policy format.
 *
 * The IR is lossless with respect to the authoring model: effect, all three
 * scopes, every `when`/`unless` clause in order, and every annotation. What is
 * *not* in the model is not invented — Cedar comments are dropped by the
 * module before this file sees them, and template links have no authoring
 * shape yet, so they are reported as a warning rather than silently discarded.
 *
 * Unconstrained scopes are the one thing left out of `props`, because `{}` and
 * absent are the same value to the serializer (`principal` with no constraint).
 * Writing `principal: {}` into every imported policy would be noise, not
 * fidelity.
 */

import {
  policyToJson,
  policyToText,
  splitPolicySet,
  templateToJson,
  type PolicyJson,
} from "../spec/wasm";
import { escapeCedarString, type CedarScope } from "../serializer";
import { extractClauses } from "./clause-text";

// ── IR ────────────────────────────────────────────────────────────

/**
 * Whether Cedar read this as a static policy or as a template.
 *
 * The discriminant is not chant's: a policy is a template exactly when it
 * carries a `?principal`/`?resource` slot, and `policyToJson` refuses one.
 */
export type CedarEntityKind = "policy" | "template";

/** One imported Cedar policy, in the lossless intermediate shape. */
export interface CedarPolicyIR {
  kind: CedarEntityKind;
  /** The Cedar policy id — its `@id`, or the envelope key it was filed under. */
  name: string;
  /** The `Cedar::Policy` props, ready to hand to the authoring class. */
  props: Record<string, unknown>;
}

export interface CedarParseResult {
  entities: CedarPolicyIR[];
  warnings: string[];
}

// ── PolicyJson → props ────────────────────────────────────────────

type EntityUidJson = { __entity: { type: string; id: string } } | { type: string; id: string };

/** `{ type: "App::User", id: "alice" }` → `App::User::"alice"`. */
function uidText(uid: EntityUidJson): string {
  const parts = "__entity" in uid ? uid.__entity : uid;
  return `${parts.type}::"${escapeCedarString(parts.id)}"`;
}

/**
 * One scope constraint, back to the authoring form.
 *
 * `undefined` is the unconstrained case — see the note at the top of the file
 * about why it is omitted rather than written as `{}`.
 */
function scopeProps(constraint: unknown): CedarScope | undefined {
  if (!constraint || typeof constraint !== "object") return undefined;
  const scope = constraint as Record<string, unknown>;

  const inTarget = (value: unknown): string | string[] | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const target = value as Record<string, unknown>;
    if (typeof target.slot === "string") return target.slot;
    if (Array.isArray(target.entities)) return target.entities.map((e) => uidText(e as EntityUidJson));
    if (target.entity) return uidText(target.entity as EntityUidJson);
    return undefined;
  };

  switch (scope.op) {
    case "is": {
      if (typeof scope.entity_type !== "string") return undefined;
      const within = inTarget(scope.in);
      return within === undefined ? { is: scope.entity_type } : { is: scope.entity_type, in: within };
    }
    case "==":
      if (typeof scope.slot === "string") return { eq: scope.slot };
      return scope.entity ? { eq: uidText(scope.entity as EntityUidJson) } : undefined;
    case "in": {
      const within = inTarget(scope);
      return within === undefined ? undefined : { in: within };
    }
    default:
      // `All`, and anything a later Cedar version adds that this does not know.
      return undefined;
  }
}

/**
 * Render one condition body back to Cedar text through the module.
 *
 * There is no entry point that renders an expression on its own, so the body
 * is wrapped in the most boring policy that can hold it and the wrapper is
 * sliced back off. The wrapper is the module's own output, so its shape is
 * fixed: `permit(principal, action, resource) when { … };`.
 */
function renderConditionBody(kind: "when" | "unless", body: unknown): string | undefined {
  const probe = {
    effect: "permit",
    principal: { op: "All" },
    action: { op: "All" },
    resource: { op: "All" },
    conditions: [{ kind, body }],
  } as unknown as PolicyJson;

  const rendered = policyToText(probe);
  if (!rendered.ok) return undefined;

  const opening = `${kind} { `;
  const start = rendered.value.indexOf(opening);
  if (start < 0 || !rendered.value.endsWith(" };")) return undefined;
  return rendered.value.slice(start + opening.length, -3);
}

/** Re-parse one clause body and return the tree the module makes of it. */
function parseConditionBody(body: string): unknown {
  const parsed = policyToJson(`permit (principal, action, resource) when { ${body} };`);
  return parsed.ok ? parsed.value.conditions[0]?.body : undefined;
}

/**
 * The `when` and `unless` clause texts, in order.
 *
 * Verbatim source wins when there is source to quote and the module agrees it
 * means the same thing; otherwise the rendered form is used. `policyToJson`
 * serializes deterministically with sorted keys (#1648 §5.2), so comparing two
 * of its trees by their JSON text is sound.
 */
function conditionProps(
  json: PolicyJson,
  sourceText: string | undefined,
): { when: string[]; unless: string[]; warnings: string[] } {
  const conditions = json.conditions ?? [];
  const warnings: string[] = [];

  const source = sourceText ? extractClauses(sourceText) : null;
  const usable = source !== null && source.length === conditions.length ? source : null;

  const when: string[] = [];
  const unless: string[] = [];

  for (const [index, condition] of conditions.entries()) {
    const candidate = usable?.[index];
    let text: string | undefined;

    if (
      candidate &&
      candidate.kind === condition.kind &&
      JSON.stringify(parseConditionBody(candidate.body)) === JSON.stringify(condition.body)
    ) {
      text = candidate.body;
    } else {
      text = renderConditionBody(condition.kind, condition.body);
    }

    if (text === undefined) {
      warnings.push(`a ${condition.kind} clause could not be rendered back to Cedar text and was dropped`);
      continue;
    }

    (condition.kind === "when" ? when : unless).push(text);
  }

  return { when, unless, warnings };
}

/**
 * One `PolicyJson` as `Cedar::Policy` props.
 *
 * Key order matches the props interface, so the generator's `JSON.stringify`
 * emits policies that read the way they would have been written.
 */
function policyProps(
  json: PolicyJson,
  sourceText: string | undefined,
): { props: Record<string, unknown>; warnings: string[] } {
  const props: Record<string, unknown> = { effect: json.effect === "forbid" ? "forbid" : "permit" };

  const principal = scopeProps(json.principal);
  if (principal) props.principal = principal;
  const action = scopeProps(json.action);
  if (action) props.action = action;
  const resource = scopeProps(json.resource);
  if (resource) props.resource = resource;

  const { when, unless, warnings } = conditionProps(json, sourceText);
  if (when.length > 0) props.when = when;
  if (unless.length > 0) props.unless = unless;

  const annotations = json.annotations ?? {};
  if (Object.keys(annotations).length > 0) props.annotations = { ...annotations };

  return { props, warnings };
}

/** The id a policy answers to: its own `@id` first, then where it was filed. */
function policyId(json: PolicyJson, fallback: string): string {
  const annotated = json.annotations?.id;
  return typeof annotated === "string" && annotated.length > 0 ? annotated : fallback;
}

// ── Envelope shape ────────────────────────────────────────────────

const ENVELOPE_KEYS = new Set(["staticPolicies", "templates", "templateLinks"]);

/**
 * Is this the JSON policy-set envelope?
 *
 * Deliberately strict about foreign keys: a CloudFormation template or a
 * Kubernetes manifest must not walk in through a permissive shape test, and
 * `detect.ts` leans on the same rule.
 */
export function isPolicySetEnvelope(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  if (!keys.every((key) => ENVELOPE_KEYS.has(key))) return false;
  return "staticPolicies" in data || "templates" in data;
}

/** Normalize the three shapes `staticPolicies` is allowed to take into pairs. */
function envelopeEntries(value: unknown, fallbackPrefix: string): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((entry, index) => [`${fallbackPrefix}${index}`, entry]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

// ── Parser ────────────────────────────────────────────────────────

export class CedarParser {
  parse(content: string): CedarParseResult {
    if (!content.trim()) return { entities: [], warnings: [] };

    const asJSON = tryParseJSON(content);
    if (isPolicySetEnvelope(asJSON)) return this.parseEnvelope(asJSON);

    return this.parseText(content);
  }

  // ── `.cedar` text ───────────────────────────────────────────────

  private parseText(content: string): CedarParseResult {
    const parts = splitPolicySet(content);
    if (!parts.ok) throw new Error(`cedar: could not parse the policy document — ${parts.error}`);

    const entities: CedarPolicyIR[] = [];
    const warnings: string[] = [];

    const collect = (
      sources: string[],
      kind: CedarEntityKind,
      convert: (source: string) => ReturnType<typeof policyToJson>,
      fallbackPrefix: string,
    ): void => {
      for (const [index, source] of sources.entries()) {
        const converted = convert(source);
        if (!converted.ok) {
          warnings.push(`skipped a ${kind} that did not convert: ${converted.error}`);
          continue;
        }
        entities.push(this.toIR(kind, converted.value, `${fallbackPrefix}${index}`, source, warnings));
      }
    };

    collect(parts.value.policies, "policy", policyToJson, "policy");
    collect(parts.value.templates, "template", templateToJson, "template");

    return { entities, warnings };
  }

  // ── JSON policy-set envelope ────────────────────────────────────

  private parseEnvelope(envelope: Record<string, unknown>): CedarParseResult {
    // `staticPolicies` is allowed to be one blob of `.cedar` text, in which
    // case the whole envelope is the text surface wearing a wrapper — templates
    // and all, since the text is what says which is which.
    const asText = typeof envelope.staticPolicies === "string" ? this.parseText(envelope.staticPolicies) : null;

    const entities: CedarPolicyIR[] = [...(asText?.entities ?? [])];
    const warnings: string[] = [...(asText?.warnings ?? [])];

    const collect = (
      value: unknown,
      kind: CedarEntityKind,
      convert: (source: string | PolicyJson) => ReturnType<typeof policyToJson>,
      fallbackPrefix: string,
    ): void => {
      for (const [key, entry] of envelopeEntries(value, fallbackPrefix)) {
        const converted = convert(entry as string | PolicyJson);
        if (!converted.ok) {
          warnings.push(`skipped ${kind} \`${key}\`: ${converted.error}`);
          continue;
        }
        // A policy given as text carries its own layout; one given as JSON has
        // none to quote, and its conditions come back as the module renders them.
        const source = typeof entry === "string" ? entry : undefined;
        entities.push(this.toIR(kind, converted.value, key, source, warnings));
      }
    };

    if (!asText) collect(envelope.staticPolicies, "policy", policyToJson, "policy");
    collect(envelope.templates, "template", templateToJson, "template");

    const links = envelope.templateLinks;
    if (Array.isArray(links) && links.length > 0) {
      warnings.push(
        `${links.length} template link(s) were not imported — a linked template has no authoring shape in this lexicon yet`,
      );
    }

    return { entities, warnings };
  }

  private toIR(
    kind: CedarEntityKind,
    json: PolicyJson,
    fallbackId: string,
    sourceText: string | undefined,
    warnings: string[],
  ): CedarPolicyIR {
    const name = policyId(json, fallbackId);
    const { props, warnings: propWarnings } = policyProps(json, sourceText);
    for (const warning of propWarnings) warnings.push(`${name}: ${warning}`);
    return { kind, name, props };
  }
}

function tryParseJSON(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
