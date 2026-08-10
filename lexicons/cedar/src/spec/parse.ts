/**
 * Turn a `.cedarschema` into the flat declaration list the emitters read.
 *
 * The canonical input is the human-readable syntax and the canonical
 * intermediate is `schemaToJsonWithResolvedTypes`' output (#1648 §4). That
 * choice buys one thing that matters here: `schemaToJson` emits
 * `{type:"EntityOrCommon", name}` for every named type, which cannot
 * distinguish an entity reference from a primitive from a common-type alias,
 * so an emitter reading it would have to re-implement Cedar's own name
 * resolution. The resolved form hands back `{type:"Entity", name:"App::User"}`
 * for references and bare primitives for the rest.
 *
 * What it does *not* resolve is common types in attribute position: those come
 * back as a bare qualified name (`{type:"App::TagSet"}`) with the definition
 * still in `commonTypes`. {@link resolveTypeRef} closes that last hop, so
 * nothing downstream ever sees an alias.
 *
 * One declaration per entity type and one per action, each carrying its own
 * fully-qualified `typeName` — which is what lets `NamingStrategy` contest
 * short names across namespaces the same way it does for every other lexicon.
 */

import type { ParsedResult } from "@intentius/chant/codegen/generate";
import { resolveSchema, type ResolvedNamespace, type ResolvedSchemaJson, type ResolvedType } from "./wasm";

// ── Types ─────────────────────────────────────────────────────────

/** A Cedar type, with common-type aliases already collapsed. */
export type CedarTypeRef =
  | { kind: "primitive"; cedar: "String" | "Long" | "Bool"; ts: "string" | "number" | "boolean" }
  | { kind: "entity"; entityType: string }
  | { kind: "set"; element: CedarTypeRef }
  | { kind: "record"; attributes: CedarAttribute[] }
  /** `ipaddr`, `decimal`, `datetime`, `duration` — carried as strings in TS. */
  | { kind: "extension"; name: string }
  /** An enumerated entity type, or anything the resolver left unrecognized. */
  | { kind: "opaque"; name: string };

export interface CedarAttribute {
  name: string;
  required: boolean;
  type: CedarTypeRef;
}

interface CedarDeclBase extends ParsedResult {
  /** Fully-qualified: `App::User`, or `App::Action::"read"`. */
  typeName: string;
  /** Namespace the declaration lives in; `""` for the empty namespace. */
  namespace: string;
  propertyTypes: Array<{ name: string }>;
  enums: unknown[];
}

export interface CedarEntityDecl extends CedarDeclBase {
  kind: "entity";
  /** Unqualified name as written in the schema. */
  shortName: string;
  /** Fully-qualified parents from `in [...]`. */
  memberOfTypes: string[];
  attributes: CedarAttribute[];
  /** Present for an enumerated entity (`entity Env enum ["prod","dev"]`). */
  enumValues?: string[];
}

export interface CedarActionDecl extends CedarDeclBase {
  kind: "action";
  /** The action id as written (`read`). */
  actionId: string;
  principalTypes: string[];
  resourceTypes: string[];
  context: CedarAttribute[];
}

export type CedarDecl = CedarEntityDecl | CedarActionDecl;

export interface ParsedSchema {
  decls: CedarDecl[];
  /** The resolved JSON, kept for the content pin and for coverage reporting. */
  resolved: ResolvedSchemaJson;
}

// ── Parsing ───────────────────────────────────────────────────────

/**
 * Parse a `.cedarschema` into declarations plus the resolved JSON it came from.
 *
 * Throws with the wasm's own message on a schema that does not parse — which
 * is the right failure for a project schema that is malformed, and reads far
 * better than the alternative, since Cedar's parse errors carry `did you mean`
 * suggestions.
 */
export function parseCedarSchema(schemaText: string): ParsedSchema {
  const result = resolveSchema(schemaText);
  if (!result.ok) {
    throw new Error(`cedar: schema did not resolve — ${result.error}`);
  }

  const resolved = result.value;
  const decls: CedarDecl[] = [];

  for (const namespace of Object.keys(resolved).sort()) {
    decls.push(...declarationsFor(namespace, resolved[namespace]));
  }

  return { decls, resolved };
}

/**
 * `parseSchema` for `generatePipeline`. One buffer in, many declarations out.
 */
export function parseSchema(_typeName: string, data: Buffer): CedarDecl[] {
  return parseCedarSchema(data.toString("utf-8")).decls;
}

function declarationsFor(namespace: string, body: ResolvedNamespace | undefined): CedarDecl[] {
  if (!body) return [];
  const commonTypes = body.commonTypes ?? {};
  const decls: CedarDecl[] = [];

  for (const shortName of Object.keys(body.entityTypes ?? {}).sort()) {
    const entity = body.entityTypes![shortName];
    const typeName = qualify(namespace, shortName);
    const attributes = recordAttributes(entity.shape, commonTypes, namespace);

    decls.push({
      kind: "entity",
      typeName,
      namespace,
      shortName,
      memberOfTypes: [...(entity.memberOfTypes ?? [])].sort(),
      attributes,
      ...(entity.enum ? { enumValues: [...entity.enum] } : {}),
      // One "property type" per entity: its attribute record. Nested anonymous
      // records are inlined rather than named, so this stays 1:1.
      propertyTypes: [{ name: `${shortName}_Attributes` }],
      enums: entity.enum ? [entity.enum] : [],
    });
  }

  for (const actionId of Object.keys(body.actions ?? {}).sort()) {
    const action = body.actions![actionId];
    const appliesTo = action.appliesTo ?? {};

    decls.push({
      kind: "action",
      typeName: actionUid(namespace, actionId),
      namespace,
      actionId,
      principalTypes: [...(appliesTo.principalTypes ?? [])].sort(),
      resourceTypes: [...(appliesTo.resourceTypes ?? [])].sort(),
      context: recordAttributes(appliesTo.context, commonTypes, namespace),
      propertyTypes: [{ name: `${actionId}_Context` }],
      enums: [],
    });
  }

  return decls;
}

/** `App` + `User` → `App::User`; the empty namespace yields the bare name. */
export function qualify(namespace: string, shortName: string): string {
  return namespace ? `${namespace}::${shortName}` : shortName;
}

/** The entity UID form an action is referenced by in a policy. */
export function actionUid(namespace: string, actionId: string): string {
  return namespace ? `${namespace}::Action::"${actionId}"` : `Action::"${actionId}"`;
}

function recordAttributes(
  shape: ResolvedType | undefined,
  commonTypes: Record<string, ResolvedType>,
  namespace: string,
): CedarAttribute[] {
  if (!shape || shape.type !== "Record" || !shape.attributes) return [];
  return Object.keys(shape.attributes)
    .sort()
    .map((name) => {
      const attr = shape.attributes![name];
      return {
        name,
        // Cedar attributes are required unless the schema says otherwise, so
        // `required` absent means required — the opposite of JSON Schema.
        required: attr.required !== false,
        type: resolveTypeRef(attr, commonTypes, namespace),
      };
    });
}

const PRIMITIVES: Record<string, { cedar: "String" | "Long" | "Bool"; ts: "string" | "number" | "boolean" }> = {
  String: { cedar: "String", ts: "string" },
  Long: { cedar: "Long", ts: "number" },
  Bool: { cedar: "Bool", ts: "boolean" },
};

const EXTENSIONS = new Set(["ipaddr", "decimal", "datetime", "duration"]);

/**
 * Collapse one resolved type node, following common-type aliases.
 *
 * `seen` guards a schema whose common types reference each other — Cedar
 * rejects true cycles, but a malformed one should not spin here.
 */
export function resolveTypeRef(
  node: ResolvedType,
  commonTypes: Record<string, ResolvedType>,
  namespace: string,
  seen: ReadonlySet<string> = new Set(),
): CedarTypeRef {
  const primitive = PRIMITIVES[node.type];
  if (primitive) return { kind: "primitive", ...primitive };

  if (node.type === "Entity") {
    return { kind: "entity", entityType: node.name ?? "" };
  }

  if (node.type === "Set") {
    const element = node.element
      ? resolveTypeRef(node.element, commonTypes, namespace, seen)
      : ({ kind: "opaque", name: "Set" } as CedarTypeRef);
    return { kind: "set", element };
  }

  if (node.type === "Record") {
    const attributes = Object.keys(node.attributes ?? {})
      .sort()
      .map((name) => {
        const attr = node.attributes![name];
        return {
          name,
          required: attr.required !== false,
          type: resolveTypeRef(attr, commonTypes, namespace, seen),
        };
      });
    return { kind: "record", attributes };
  }

  if (EXTENSIONS.has(node.type)) {
    return { kind: "extension", name: node.type };
  }

  // `EntityOrCommon` should not survive resolution, but a defensive branch
  // costs nothing and keeps a future wasm version from emitting `unknown`.
  const named = node.type === "EntityOrCommon" ? (node.name ?? "") : node.type;

  const commonKey = named.startsWith(`${namespace}::`) ? named.slice(namespace.length + 2) : named;
  const definition = commonTypes[commonKey];
  if (definition && !seen.has(named)) {
    return resolveTypeRef(definition, commonTypes, namespace, new Set([...seen, named]));
  }

  return { kind: "opaque", name: named };
}
