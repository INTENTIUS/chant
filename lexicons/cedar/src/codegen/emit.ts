/**
 * The three generated artifacts, all built from one model.
 *
 * `lexicon-cedar.json`, `index.ts` and `index.d.ts` describe the same set of
 * declarations, and the only way they cannot skew is if they are derived from
 * the same pass — which is what {@link buildEmitModel} is for. Nothing here
 * reads the clock or a random source: keys come out of the resolved schema
 * already sorted (Rust `BTreeMap`, #1648 §5.2), everything else is sorted
 * explicitly, so regenerating twice produces identical bytes.
 */

import type { NamingStrategy } from "@intentius/chant/codegen/naming";
import type { CedarAttribute, CedarDecl, CedarTypeRef } from "../spec/parse";
import { deriveName, POLICY_TS_NAME, POLICY_TYPE } from "./naming";

export const LEXICON_NAME = "cedar";

// ── Model ─────────────────────────────────────────────────────────

export interface EmitEntity {
  tsName: string;
  /** `App::User` */
  typeName: string;
  namespace: string;
  /** TS name of the attribute-record property class, e.g. `UserAttributes`. */
  attributesTsName: string;
  /** TS name of the entity-UID string type, e.g. `UserUid`. */
  uidTsName: string;
  memberOfTypes: string[];
  attributes: CedarAttribute[];
  enumValues?: string[];
}

export interface EmitAction {
  tsName: string;
  /** `App::Action::"read"` */
  typeName: string;
  namespace: string;
  actionId: string;
  /** TS name of the context-record property class, e.g. `ReadContext`. */
  contextTsName: string;
  principalTypes: string[];
  resourceTypes: string[];
  context: CedarAttribute[];
}

export interface EmitModel {
  entities: EmitEntity[];
  actions: EmitAction[];
  /** entityType → the UID type name, for rendering `{type:"Entity"}` references. */
  uidTypeByEntityType: Map<string, string>;
}

/**
 * Assign every generated name, once.
 *
 * `NamingStrategy` names the primary declarations; the derived record names
 * are de-duplicated against the same pool so a `UserAttributes` entity type in
 * the schema cannot quietly take the name `User`'s attribute record wants.
 */
export function buildEmitModel(decls: CedarDecl[], naming: NamingStrategy): EmitModel {
  const taken = new Set<string>([POLICY_TS_NAME]);

  const entities: EmitEntity[] = [];
  const actions: EmitAction[] = [];

  const sorted = [...decls].sort((a, b) => a.typeName.localeCompare(b.typeName));

  // Primary names first, all of them, before any derived name is claimed —
  // otherwise `UserAttributes` (derived) could take the name an entity type
  // literally called `UserAttributes` is entitled to.
  const primaryNames = new Map<string, string>();
  for (const decl of sorted) {
    const base = naming.resolve(decl.typeName);
    if (!base) continue;
    // `NamingStrategy`'s last phase qualifies a collision with the service
    // name, which for Cedar is the namespace — so two declarations in the
    // *same* namespace that reduce to the same short name (an entity type
    // `ReadAction` beside an action `read`) both come back as `AppReadAction`.
    // Silently letting the second overwrite the first in the registry is the
    // one outcome worth refusing.
    primaryNames.set(decl.typeName, deriveName(base, "", taken));
  }

  for (const decl of sorted) {
    const tsName = primaryNames.get(decl.typeName);
    if (!tsName) continue;

    if (decl.kind === "entity") {
      entities.push({
        tsName,
        typeName: decl.typeName,
        namespace: decl.namespace,
        attributesTsName: deriveName(tsName, "Attributes", taken),
        uidTsName: deriveName(tsName, "Uid", taken),
        memberOfTypes: decl.memberOfTypes,
        attributes: decl.attributes,
        ...(decl.enumValues ? { enumValues: decl.enumValues } : {}),
      });
    } else {
      actions.push({
        tsName,
        typeName: decl.typeName,
        namespace: decl.namespace,
        actionId: decl.actionId,
        contextTsName: deriveName(stripActionSuffix(tsName), "Context", taken),
        principalTypes: decl.principalTypes,
        resourceTypes: decl.resourceTypes,
        context: decl.context,
      });
    }
  }

  entities.sort((a, b) => a.tsName.localeCompare(b.tsName));
  actions.sort((a, b) => a.tsName.localeCompare(b.tsName));

  const uidTypeByEntityType = new Map<string, string>();
  for (const entity of entities) uidTypeByEntityType.set(entity.typeName, entity.uidTsName);

  return { entities, actions, uidTypeByEntityType };
}

/** `ReadAction` → `Read`, so the context type reads `ReadContext`. */
function stripActionSuffix(tsName: string): string {
  return tsName.endsWith("Action") && tsName.length > "Action".length
    ? tsName.slice(0, -"Action".length)
    : tsName;
}

// ── TypeScript type rendering ─────────────────────────────────────

/**
 * Render one Cedar type as a TypeScript type expression.
 *
 * Extension types (`ipaddr`, `decimal`, `datetime`, `duration`) render as
 * `string`: Cedar constructs them from string literals in policy text, and
 * inventing branded TS types for values chant never evaluates would be
 * decoration.
 */
export function renderType(type: CedarTypeRef, model: EmitModel): string {
  switch (type.kind) {
    case "primitive":
      return type.ts;
    case "entity":
      return model.uidTypeByEntityType.get(type.entityType) ?? "string";
    case "set": {
      const inner = renderType(type.element, model);
      return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "record":
      return type.attributes.length === 0
        ? "Record<string, never>"
        : `{ ${type.attributes.map((a) => `${propertyKey(a.name)}${a.required ? "" : "?"}: ${renderType(a.type, model)};`).join(" ")} }`;
    case "extension":
      return "string";
    case "opaque":
      return "string";
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quote an attribute name that is not a bare identifier — Cedar allows both. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** The Cedar surface syntax for a type, for doc comments and the registry. */
export function cedarTypeText(type: CedarTypeRef): string {
  switch (type.kind) {
    case "primitive":
      return type.cedar;
    case "entity":
      return type.entityType;
    case "set":
      return `Set<${cedarTypeText(type.element)}>`;
    case "record":
      return `{ ${type.attributes.map((a) => `"${a.name}"${a.required ? "" : "?"}: ${cedarTypeText(a.type)}`).join(", ")} }`;
    case "extension":
      return type.name;
    case "opaque":
      return type.name;
  }
}

// ── Registry ──────────────────────────────────────────────────────

interface RegistryEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: string;
  [key: string]: unknown;
}

/** `App::User` → `App::User.Attributes`, the record type's own spec name. */
export function attributesTypeName(entityTypeName: string): string {
  return `${entityTypeName}.Attributes`;
}

/** `App::Action::"read"` → `App::Action::"read".Context`. */
export function contextTypeName(actionTypeName: string): string {
  return `${actionTypeName}.Context`;
}

function attributeTable(attributes: CedarAttribute[]): Record<string, { type: string; required: boolean }> {
  const out: Record<string, { type: string; required: boolean }> = {};
  for (const attr of [...attributes].sort((a, b) => a.name.localeCompare(b.name))) {
    out[attr.name] = { type: cedarTypeText(attr.type), required: attr.required };
  }
  return out;
}

/** Build `lexicon-cedar.json`. */
export function generateRegistry(model: EmitModel): string {
  const entries: Record<string, RegistryEntry> = {};

  entries[POLICY_TS_NAME] = {
    resourceType: POLICY_TYPE,
    kind: "resource",
    lexicon: LEXICON_NAME,
    description: "A Cedar policy — the unit this lexicon serializes to .cedar text and the JSON policy format.",
    properties: {
      effect: { type: "permit | forbid", required: false },
      principal: { type: "scope", required: false },
      action: { type: "scope", required: false },
      resource: { type: "scope", required: false },
      when: { type: "Set<expression>", required: false },
      unless: { type: "Set<expression>", required: false },
      annotations: { type: "Record<String, String>", required: false },
    },
  };

  for (const entity of model.entities) {
    entries[entity.tsName] = {
      resourceType: entity.typeName,
      kind: "resource",
      lexicon: LEXICON_NAME,
      namespace: entity.namespace,
      memberOfTypes: entity.memberOfTypes,
      properties: attributeTable(entity.attributes),
      ...(entity.enumValues ? { enumValues: entity.enumValues } : {}),
    };
    entries[entity.attributesTsName] = {
      resourceType: attributesTypeName(entity.typeName),
      kind: "property",
      lexicon: LEXICON_NAME,
      namespace: entity.namespace,
      properties: attributeTable(entity.attributes),
    };
  }

  for (const action of model.actions) {
    entries[action.tsName] = {
      resourceType: action.typeName,
      kind: "resource",
      lexicon: LEXICON_NAME,
      namespace: action.namespace,
      principalTypes: action.principalTypes,
      resourceTypes: action.resourceTypes,
      properties: attributeTable(action.context),
    };
    entries[action.contextTsName] = {
      resourceType: contextTypeName(action.typeName),
      kind: "property",
      lexicon: LEXICON_NAME,
      namespace: action.namespace,
      properties: attributeTable(action.context),
    };
  }

  const sorted: Record<string, RegistryEntry> = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];

  return JSON.stringify(sorted, null, 2) + "\n";
}

// ── Shared declaration bodies ─────────────────────────────────────

const BANNER = "// Code generated by chant generate. DO NOT EDIT.";

/** A template-literal type for an entity UID: `` `App::User::"${string}"` ``. */
function uidTypeExpression(entityTypeName: string): string {
  return "`" + entityTypeName + '::"${string}"`';
}

function docBlock(lines: string[], indent = ""): string[] {
  if (lines.length === 0) return [];
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`];
}

function attributeLines(attributes: CedarAttribute[], model: EmitModel): string[] {
  return attributes.map(
    (attr) => `  ${propertyKey(attr.name)}${attr.required ? "" : "?"}: ${renderType(attr.type, model)};`,
  );
}

function unionOr(members: string[], fallback: string): string {
  return members.length > 0 ? members.join(" | ") : fallback;
}

/**
 * The shared body of `index.ts` and `index.d.ts` — everything that is
 * type-level and therefore identical in both.
 */
function typeDeclarations(model: EmitModel): string[] {
  const lines: string[] = [];

  for (const entity of model.entities) {
    lines.push(
      ...docBlock([
        `Entity UID of \`${entity.typeName}\`.`,
        ...(entity.memberOfTypes.length > 0 ? [`Member of: ${entity.memberOfTypes.join(", ")}.`] : []),
      ]),
      `export type ${entity.uidTsName} = ${uidTypeExpression(entity.typeName)};`,
      "",
      `export interface ${entity.attributesTsName}Props {`,
      ...attributeLines(entity.attributes, model),
      "}",
      "",
    );
  }

  for (const action of model.actions) {
    lines.push(
      `export interface ${action.contextTsName}Props {`,
      ...attributeLines(action.context, model),
      "}",
      "",
    );
  }

  lines.push(
    "/** Every entity type name the schema declares, as Cedar writes it. */",
    `export type EntityTypeName = ${unionOr(model.entities.map((e) => JSON.stringify(e.typeName)), "never")};`,
    "",
    "/** Every entity UID the schema can produce. */",
    `export type EntityUid = ${unionOr(model.entities.map((e) => e.uidTsName), "never")};`,
    "",
    "/** Every action UID the schema declares. */",
    `export type ActionUid = ${unionOr(model.actions.map((a) => JSON.stringify(a.typeName)), "never")};`,
    "",
    "/** Anything a policy scope may name. */",
    "export type PolicyRef = EntityUid | ActionUid;",
    "",
    "/** A Cedar policy either permits or forbids; there is no third effect. */",
    'export type PolicyEffect = "permit" | "forbid";',
    "",
    ...docBlock([
      "One scope position (`principal`, `action`, `resource`).",
      "",
      "`{}` is the unconstrained form Cedar writes as a bare variable. The",
      "constrained forms mirror the grammar: `== E`, `in E`, `in [E, …]`,",
      "`is T`, and `is T in E`.",
    ]),
    "export type PolicyScope =",
    "  | Record<string, never>",
    "  | { eq: PolicyRef; in?: never; is?: never }",
    "  | { in: PolicyRef | PolicyRef[]; eq?: never; is?: never }",
    "  | { is: EntityTypeName; in?: PolicyRef | PolicyRef[]; eq?: never };",
    "",
    ...docBlock([
      "The props of a `Cedar::Policy`.",
      "",
      "`when`/`unless` carry Cedar expression text. They stay strings because",
      "Cedar's expression grammar is the policy language itself — typing it in",
      "TypeScript is import/reconcile's problem (epic #1645 sub-issue 6), not",
      "codegen's.",
    ]),
    "export interface PolicyProps {",
    "  /** Defaults to `permit` when omitted. */",
    "  effect?: PolicyEffect;",
    "  principal?: PolicyScope;",
    "  action?: PolicyScope;",
    "  resource?: PolicyScope;",
    "  /** Cedar expression strings, each emitted as its own `when { … }` clause. */",
    "  when?: string[];",
    "  /** Cedar expression strings, each emitted as its own `unless { … }` clause. */",
    "  unless?: string[];",
    "  /** Emitted as `@key(\"value\")`; an explicit `id` wins over the logical name. */",
    "  annotations?: Record<string, string>;",
    "}",
    "",
  );

  return lines;
}

// ── index.ts ──────────────────────────────────────────────────────

/** Build the runtime `index.ts`. */
export function generateRuntimeIndex(model: EmitModel): string {
  const lines: string[] = [
    BANNER,
    'import type { Declarable } from "@intentius/chant/declarable";',
    'import { createProperty, createResource } from "./runtime";',
    "",
    ...typeDeclarations(model),
    ...docBlock([
      "The policy resource. Declare one per policy:",
      "",
      "```ts",
      'export const allowOwnerRead = new Policy({',
      '  principal: { is: "App::User" },',
      "  action: { eq: ReadAction },",
      "  when: ['resource.owner == principal'],",
      "});",
      "```",
    ]),
    `export const ${POLICY_TS_NAME} = createResource(${JSON.stringify(POLICY_TYPE)}, ${JSON.stringify(LEXICON_NAME)}, {}) as unknown as new (props: PolicyProps) => Declarable;`,
    "",
  ];

  for (const entity of model.entities) {
    lines.push(
      `export const ${entity.tsName} = createResource(${JSON.stringify(entity.typeName)}, ${JSON.stringify(LEXICON_NAME)}, {}) as unknown as new (props: ${entity.attributesTsName}Props) => Declarable;`,
      `export const ${entity.attributesTsName} = createProperty(${JSON.stringify(attributesTypeName(entity.typeName))}, ${JSON.stringify(LEXICON_NAME)}) as unknown as new (props: ${entity.attributesTsName}Props) => Declarable;`,
    );
  }
  if (model.entities.length > 0) lines.push("");

  for (const action of model.actions) {
    lines.push(
      ...docBlock([
        `\`${action.typeName}\`.`,
        ...(action.principalTypes.length > 0 ? [`Principals: ${action.principalTypes.join(", ")}.`] : []),
        ...(action.resourceTypes.length > 0 ? [`Resources: ${action.resourceTypes.join(", ")}.`] : []),
      ]),
      `export const ${action.tsName} = ${JSON.stringify(action.typeName)} as const;`,
      `export const ${action.contextTsName} = createProperty(${JSON.stringify(contextTypeName(action.typeName))}, ${JSON.stringify(LEXICON_NAME)}) as unknown as new (props: ${action.contextTsName}Props) => Declarable;`,
    );
  }
  if (model.actions.length > 0) lines.push("");

  lines.push(
    "/** Every generated action constant, for exhaustive iteration. */",
    `export const ALL_ACTIONS: readonly ActionUid[] = [${model.actions.map((a) => a.tsName).join(", ")}];`,
    "",
    "/** Every entity type name the schema declares. */",
    `export const ALL_ENTITY_TYPES: readonly EntityTypeName[] = [${model.entities.map((e) => JSON.stringify(e.typeName)).join(", ")}];`,
    "",
  );

  return lines.join("\n");
}

// ── index.d.ts ────────────────────────────────────────────────────

/**
 * Build the declaration-only `index.d.ts`.
 *
 * It is validated standalone by core's `typecheckDTS`, which runs tsc in a
 * temp directory with no `node_modules` beyond a stub for
 * `@intentius/chant/declarable` — so this file may import that and nothing
 * else, and every other type it uses has to be declared here.
 */
export function generateTypes(model: EmitModel): string {
  const lines: string[] = [
    BANNER,
    'import type { Declarable } from "@intentius/chant/declarable";',
    "",
    ...typeDeclarations(model),
    `export declare const ${POLICY_TS_NAME}: new (props: PolicyProps) => Declarable;`,
    "",
  ];

  for (const entity of model.entities) {
    lines.push(
      `export declare const ${entity.tsName}: new (props: ${entity.attributesTsName}Props) => Declarable;`,
      `export declare const ${entity.attributesTsName}: new (props: ${entity.attributesTsName}Props) => Declarable;`,
    );
  }
  if (model.entities.length > 0) lines.push("");

  for (const action of model.actions) {
    lines.push(
      `export declare const ${action.tsName}: ${JSON.stringify(action.typeName)};`,
      `export declare const ${action.contextTsName}: new (props: ${action.contextTsName}Props) => Declarable;`,
    );
  }
  if (model.actions.length > 0) lines.push("");

  lines.push(
    "export declare const ALL_ACTIONS: readonly ActionUid[];",
    "export declare const ALL_ENTITY_TYPES: readonly EntityTypeName[];",
    "",
  );

  return lines.join("\n");
}

// ── runtime.ts ────────────────────────────────────────────────────

/** The tiny re-export module `index.ts` imports its factories from. */
export const RUNTIME_TS = `${BANNER}
export { createProperty, createResource } from "@intentius/chant/runtime";
`;
