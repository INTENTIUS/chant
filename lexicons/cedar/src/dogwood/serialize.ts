/**
 * The `.dw` serializer leg.
 *
 * Runs inside the cedar serializer, not beside it: `serializeDogwood` is
 * called once the cedar policies have been rendered, and its files land in the
 * same `SerializerResult`. That is the whole point of shipping dogwood as a
 * dialect — a `.dw` file stripped of Cedar semantics is meaningless, and a
 * project's temporal policies and its plain Cedar policies are one policy set
 * with two halves.
 *
 * Nothing here re-implements Cedar rendering. The policy head comes from
 * `../serializer`'s `renderPolicyHead`, the scope forms from its
 * `renderScope`, and the `when`/`unless` bodies from its `conditionStrings`,
 * so a change to how a scope is written moves both outputs at once.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { conditionStrings, getProps, isRecord, renderPolicyHead, resolvePolicyId } from "../policy-text";
import { renderCondition, type TemporalCondition } from "./temporal";
import { renderEventSchema, type EventSchema } from "./event-schema";
import { renderMacroLibrary, type MacroDefinition } from "./macros";
import {
  DOGWOOD_EVENT_SCHEMA_FILENAME,
  DOGWOOD_EVENT_SCHEMA_TYPE,
  DOGWOOD_MACRO_FILENAME,
  DOGWOOD_MACRO_LIBRARY_TYPE,
  DOGWOOD_POLICY_FILENAME,
  DOGWOOD_POLICY_TYPE,
} from "./policy";

/** Files ending in this carry dogwood policy text. */
export const DOGWOOD_POLICY_SUFFIX = ".dw";

/** Files ending in this carry an event schema. */
export const DOGWOOD_EVENT_SCHEMA_SUFFIX = ".dwschema";

/** What the leg produced: files to write, and anything the build should say out loud. */
export interface DogwoodSerializeResult {
  files: Record<string, string>;
  warnings: string[];
}

// ── Clause rendering ──────────────────────────────────────────────

function temporalConditions(value: unknown): TemporalCondition[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((node): node is TemporalCondition => isRecord(node) && typeof node.op === "string");
}

/**
 * One policy, in `.dw` surface syntax.
 *
 * Clause order is fixed rather than authored: every `when` form, then every
 * `unless` form. Cedar evaluates a policy's conditions as a conjunction, and
 * so does dogwood, so the order carries no meaning — fixing it means a policy
 * that gains a temporal clause does not reshuffle the ones already there.
 */
export function renderTemporalPolicyText(id: string, props: Record<string, unknown>): string {
  const lines = renderPolicyHead(id, props);

  for (const clause of conditionStrings(props.when)) lines.push(`when { ${clause} }`);
  for (const clause of conditionStrings(props.whenGuardrails)) lines.push(`when guardrails { ${clause} }`);
  for (const node of temporalConditions(props.whenTemporal)) {
    lines.push("when temporal {", `    ${renderCondition(node)}`, "}");
  }

  for (const clause of conditionStrings(props.unless)) lines.push(`unless { ${clause} }`);
  for (const clause of conditionStrings(props.unlessGuardrails)) lines.push(`unless guardrails { ${clause} }`);
  for (const node of temporalConditions(props.unlessTemporal)) {
    lines.push("unless temporal {", `    ${renderCondition(node)}`, "}");
  }

  return lines.join("\n") + ";";
}

// ── The walker ────────────────────────────────────────────────────

/**
 * Same visitor contract as the cedar serializer's: a reference collapses to
 * the text a policy names it by. The temporal AST is plain data, so the walker
 * passes it through untouched while still resolving any Declarable a scope
 * position holds.
 */
const dogwoodVisitor: SerializerVisitor = {
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

// ── The leg ───────────────────────────────────────────────────────

/**
 * Render every dogwood entity in the build.
 *
 * Returns `undefined` when the build holds no temporal policies, event schemas
 * or macro libraries at all — a cedar-only project sees no `.dw` output and no
 * behaviour change.
 *
 * Ids come from `resolvePolicyId`, the same rule `cedarPolicyRecords` uses, so
 * a policy's `@id` does not depend on which leg rendered it.
 */
export function serializeDogwood(entities: Map<string, Declarable>): DogwoodSerializeResult | undefined {
  // Reverse map first: walkValue resolves a Declarable reference by identity,
  // so every entity has to be known before any of them is walked.
  const entityNames = new Map<Declarable, string>();
  for (const [name, entity] of entities) {
    entityNames.set(entity, name);
  }

  const policyText: string[] = [];
  const inlineMacros: MacroDefinition[] = [];
  const macroFiles = new Map<string, MacroDefinition[]>();
  const schemaFiles = new Map<string, { name: string; schema: EventSchema }>();
  const warnings: string[] = [];

  for (const [name, entity] of entities) {
    if (isPropertyDeclarable(entity)) continue;
    if (
      entity.entityType !== DOGWOOD_POLICY_TYPE &&
      entity.entityType !== DOGWOOD_EVENT_SCHEMA_TYPE &&
      entity.entityType !== DOGWOOD_MACRO_LIBRARY_TYPE
    ) {
      continue;
    }

    const props = walkValue(getProps(entity), entityNames, dogwoodVisitor) as Record<string, unknown>;

    if (entity.entityType === DOGWOOD_POLICY_TYPE) {
      policyText.push(renderTemporalPolicyText(resolvePolicyId(name, props), props));
      continue;
    }

    if (entity.entityType === DOGWOOD_MACRO_LIBRARY_TYPE) {
      const defs = Array.isArray(props.macros) ? (props.macros as MacroDefinition[]) : [];
      if (defs.length === 0) {
        warnings.push(`dogwood: macro library "${name}" declares no macros, so nothing was emitted for it`);
        continue;
      }
      if (props.inline === true) {
        inlineMacros.push(...defs);
        continue;
      }
      const filename = typeof props.filename === "string" ? props.filename : DOGWOOD_MACRO_FILENAME;
      macroFiles.set(filename, [...(macroFiles.get(filename) ?? []), ...defs]);
      continue;
    }

    // DOGWOOD_EVENT_SCHEMA_TYPE
    const schema = props.schema;
    if (!isRecord(schema) || !Array.isArray(schema.events)) {
      warnings.push(`dogwood: event schema "${name}" has no \`schema\` prop, so no .dwschema was written for it`);
      continue;
    }
    const filename = typeof props.filename === "string" ? props.filename : DOGWOOD_EVENT_SCHEMA_FILENAME;
    const existing = schemaFiles.get(filename);
    if (existing) {
      // Two schemas cannot share a file: `max_window` is a single directive at
      // the top, so concatenating them would emit something upstream rejects.
      warnings.push(
        `dogwood: event schemas "${existing.name}" and "${name}" both target ${filename}; only "${existing.name}" was written — give one of them an explicit \`filename\``,
      );
      continue;
    }
    schemaFiles.set(filename, { name, schema: schema as unknown as EventSchema });
  }

  // Warnings alone are enough to report: a dogwood entity that produced no
  // file is exactly the case worth saying out loud, and returning `undefined`
  // here would swallow the reason.
  if (
    policyText.length === 0 &&
    inlineMacros.length === 0 &&
    macroFiles.size === 0 &&
    schemaFiles.size === 0 &&
    warnings.length === 0
  ) {
    return undefined;
  }

  const files: Record<string, string> = {};

  if (policyText.length > 0 || inlineMacros.length > 0) {
    const sections: string[] = [];
    if (inlineMacros.length > 0) sections.push(renderMacroLibrary(inlineMacros).trimEnd());
    sections.push(...policyText);
    files[DOGWOOD_POLICY_FILENAME] = sections.join("\n\n") + "\n";
  }

  for (const [filename, defs] of macroFiles) {
    files[filename] = renderMacroLibrary(defs);
  }

  for (const [filename, { schema }] of schemaFiles) {
    files[filename] = renderEventSchema(schema);
  }

  return { files, warnings };
}
