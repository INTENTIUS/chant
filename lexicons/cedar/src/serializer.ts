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
 *
 * A third view arrives when the build holds dogwood entities (#1658): `.dw`
 * policy text and its `.dwschema`/`macros.dw` companions, rendered by
 * `./dogwood/serialize.ts` and returned in the same result. Both legs share
 * `./policy-text.ts` rather than a copy of it, because a `.dw` policy's head
 * *is* a Cedar policy's head.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { policyToJson, splitPolicySet, templateToJson, type PolicyJson } from "./spec/wasm";
import { serializeDogwood } from "./dogwood/serialize";
import {
  conditionStrings,
  getProps,
  isRecord,
  renderPolicyHead,
  resolvePolicyId,
} from "./policy-text";

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
//
// Rendering the dogwood dialect shares lives in `./policy-text.ts`, along with
// `resolvePolicyId` — the one rule linking a chant entity to a policy id, which
// #1652 extracted for the AVP observation and the `.dw` leg needs for the same
// reason. Re-exported here so this module stays the one import a caller needs.

export {
  conditionStrings,
  escapeCedarString,
  getProps,
  isRecord,
  policyIdFromLogicalName,
  renderPolicyHead,
  renderScope,
  resolvePolicyId,
} from "./policy-text";

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

/**
 * One policy, as `.cedar` text.
 *
 * Exported because the AVP embedding (#1652) needs exactly this string and
 * nothing else — `AWS::VerifiedPermissions::Policy` carries its policy as
 * `Definition.Static.Statement`, a single Cedar policy rather than a set. Two
 * renderers would be two dialects; there is one.
 *
 * The head comes from `renderPolicyHead`, which the dogwood dialect's `.dw`
 * leg also calls: three surfaces, one rendering of an annotation and a scope.
 */
export function renderPolicyText(id: string, props: Record<string, unknown>): string {
  const lines = renderPolicyHead(id, props);

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

  // The dogwood temporal dialect ships inside this lexicon (epic #1646): a
  // `.dw` file stripped of Cedar semantics is meaningless, so its checks are
  // this serializer's, under their own published id family.
  extraRulePrefixes: ["DWD"],

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const policyText: string[] = [];

    for (const { id, props } of cedarPolicyRecords(entities)) {
      policyText.push(renderPolicyText(id, props));
    }

    // The dogwood dialect's own entities (#1658). Emitted from here rather
    // than from a second serializer because they are one policy set with two
    // halves — the `.dw` text and the `.cedar` text describe the same system,
    // and a project holding only temporal policies still gets its files.
    const dogwood = serializeDogwood(entities);

    if (policyText.length === 0 && !dogwood) return "";

    const files: Record<string, string> = {};
    const warnings: string[] = [...(dogwood?.warnings ?? [])];
    let primary = "";

    if (policyText.length > 0) {
      primary = policyText.join("\n\n") + "\n";
      const { doc, error } = policySetJSON(primary);

      // A policy set Cedar cannot read is a real defect, but it is the lint and
      // post-synth surface's to report (#1651) — the text is still the artifact
      // every evaluator consumes, so it is emitted either way, with the module's
      // own message carried out as a build warning rather than swallowed.
      if (doc) {
        files[CEDAR_JSON_FILENAME] = JSON.stringify(doc, null, 2) + "\n";
      } else {
        warnings.push(
          `cedar: the emitted policy text did not parse, so ${CEDAR_JSON_FILENAME} was not written — ${error}`,
        );
      }
    }

    Object.assign(files, dogwood?.files ?? {});

    return {
      primary,
      ...(Object.keys(files).length > 0 ? { files } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
