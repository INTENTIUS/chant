/**
 * Control Plane Core API OpenAPI 3.0.3 parser.
 *
 * The cpln spec is one document with a schema per kind. Unlike the k8s swagger
 * or ARM, it is mostly *inline*: `workload.spec.containers[].readinessProbe`
 * is nested object literals all the way down, with only a handful of named
 * `$ref` schemas (`query`, `policy_binding`, `secret_opaque`, …). So there is
 * no upstream definition table to lift property types out of — this parser
 * synthesizes them from the tree, which raises two questions the naming rules
 * below answer: what to call them, and where to stop.
 *
 * ## Naming
 *
 * A `$ref`'d schema keeps its upstream name (`query` → `Query`), so a shape
 * shared by two kinds is emitted once and both reference it. An inline object
 * is named by its path under the nearest named ancestor
 * (`workload.spec.containers[].readinessProbe` → `WorkloadSpecContainersReadinessProbe`).
 * Names are long, but they are derived rather than chosen, so two runs of the
 * generator over the same spec agree, and a property that moves in the spec
 * produces a visible rename rather than a silent re-binding.
 *
 * Arrays do not contribute a segment: an array of objects and a single object
 * yield the same class, because `containers[]` and `containers` describe the
 * same shape.
 *
 * ## Where it stops
 *
 * One subtree is deliberately untyped: `spec.sidecar.envoy` on both `gvc` and
 * `workload`. It is a raw Envoy bootstrap fragment that Control Plane passes
 * through verbatim — `typed_config`, `google_grpc` channel credentials, the
 * lot — and expanding it costs 81 property-type classes on `gvc` alone, more
 * than four times every other shape in this lexicon combined, to type a field
 * whose contents are Envoy's contract and not Control Plane's. It resolves to
 * `Record<string, unknown>`; see {@link LOOSENED_PATHS}.
 *
 * Everything else is typed in full. That comes to 137 property types across
 * the eight kinds, with a natural maximum depth of 6.
 */

import {
  extractConstraints as coreExtractConstraints,
  primaryType,
  type JsonSchemaProperty,
  type PropertyConstraints,
} from "@intentius/chant/codegen/json-schema";
import { KINDS, NAMESPACE, SERVICE, type CplnKind } from "../kinds";

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  constraints: PropertyConstraints;
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
}

export interface CplnParseResult {
  resource: ParsedResource;
  /** Always empty — cpln emits property types as standalone results, like fly. */
  propertyTypes: Array<{ name: string; defType: string }>;
  /** Always empty — enums are inlined as string-literal unions. */
  enums: Array<{ name: string; values: string[] }>;
  /** Whether this entity is a property type rather than a resource. */
  isProperty?: boolean;
}

// ── OpenAPI shapes ─────────────────────────────────────────────────

interface OpenAPISchema extends JsonSchemaProperty {
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];
  additionalProperties?: boolean | OpenAPISchema;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  readOnly?: boolean;
}

interface OpenAPISpec {
  components?: { schemas?: Record<string, OpenAPISchema> };
}

const REF_PREFIX = "#/components/schemas/";

/** Backstop against a self-referential `$ref` the spec does not currently have. */
const MAX_DEPTH = 16;

// ── Curation ───────────────────────────────────────────────────────

/**
 * Property paths that resolve to `Record<string, unknown>` instead of being
 * expanded. Keyed `<kind>:<dotted path>`; see the module comment for why.
 */
const LOOSENED_PATHS = new Set(["gvc:spec.sidecar.envoy", "workload:spec.sidecar.envoy"]);

/**
 * Types the spec states too loosely to author against, keyed `<kind>:<path>`.
 *
 * `tags` is declared as a bare `{"type": "object"}` on all eight kinds, which
 * resolves to `Record<string, unknown>` — technically true and useless in
 * practice, since Control Plane stores tag values as strings and an object
 * value is rejected at apply time. Narrowing it here turns a runtime rejection
 * into a compile error, and matters more than usual for this lexicon because
 * `tags` is also where the ownership marker is stamped.
 */
const TYPE_OVERRIDES = new Map<string, string>(KINDS.map((k) => [`${k.kind}:tags`, "Record<string, string>"]));

/**
 * Top-level properties treated as read-only attributes on every kind. These
 * are the envelope the API stamps on a resource, not authoring surface.
 */
const ENVELOPE_ATTRIBUTES = new Set(["id", "kind", "version", "created", "lastModified", "links", "alias", "status"]);

/**
 * Attribute names core's runtime already owns on every `Declarable`.
 *
 * `createResource` installs `lexicon`, `entityType`, `kind`, `props`,
 * `attributes` and `Ref` as non-configurable instance properties, then defines
 * an `AttrRef` for each declared attribute. An attribute colliding with one of
 * those throws `TypeError: Cannot redefine property` in the constructor — not
 * at generate time, at the moment a user writes `new Gvc({...})`.
 *
 * cpln collides on exactly one: every kind carries a read-only `kind`
 * discriminator. Dropping it costs nothing, because the chant type already
 * says which kind a resource is and the serializer emits `kind:` from the
 * kinds table rather than from the resource. The rest of the set is guarded so
 * a future upstream field cannot reintroduce the same failure quietly.
 */
const RESERVED_ATTRIBUTE_NAMES = new Set(["lexicon", "entityType", "kind", "props", "attributes", "Ref"]);

/**
 * Properties the spec fails to mark `readOnly` but which are server-computed.
 *
 * `workload.health` is a rollup of readiness across locations — the API
 * populates it and rejects nothing if you send it, so it round-trips as
 * writable and would show up as permanent drift on every workload if this
 * lexicon declared it. It is an attribute here regardless of the spec.
 */
const FORCED_ATTRIBUTES = new Set(["workload:health"]);

/**
 * The spec marks `required: []` on every kind — nothing is required, including
 * a resource's own name. That is true of a PATCH body and false of anything
 * chant would synthesize, so `name` is required on every kind, and the two
 * discriminators without which a manifest is meaningless are required on their
 * own kind.
 */
const FORCED_REQUIRED = new Set(["name", "secret:type", "policy:targetKind"]);

/**
 * The `gvc` property every GVC-scoped kind carries.
 *
 * Synthetic only with respect to the OpenAPI document. A workload's GVC is a
 * URL segment there (`/org/{org}/gvc/{gvc}/workload/{name}`) rather than a body
 * field, so the `workload` schema has none; `identity` and `volumeset` do carry
 * one, inconsistently — a string on the first, an object on the second.
 *
 * The `cpln apply` manifest format, which is what this lexicon actually emits,
 * has a real top-level `gvc` key for exactly this purpose: "you can specify
 * either a `gvc` property in the file or use the `--gvc` flag, but not both".
 * So all three kinds get the same required `gvc: string`, it serializes
 * straight through, and a manifest stays self-contained rather than depending
 * on which flag the caller remembered. The Terraform provider makes the same
 * call (`cpln_workload.gvc`).
 */
const SYNTHETIC_GVC_PROP: ParsedProperty = {
  name: "gvc",
  tsType: "string",
  required: true,
  description: "Name of the GVC this resource belongs to.",
  constraints: {},
};

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the cpln OpenAPI spec into the modelled kinds and every property type
 * reachable from them.
 */
export function parseCplnOpenAPI(data: string | Buffer): CplnParseResult[] {
  const spec: OpenAPISpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const schemas = spec.components?.schemas ?? {};

  // Synthesized property types, keyed by class name. Populated as a side effect
  // of resolving each kind's properties; a shape reached twice is emitted once.
  const propertyTypes = new Map<string, ParsedResource>();
  const inProgress = new Set<string>();

  const results: CplnParseResult[] = [];

  for (const kind of KINDS) {
    const schema = schemas[kind.schema];
    if (!schema) {
      throw new Error(
        `cpln spec has no \`components.schemas.${kind.schema}\` backing kind \`${kind.kind}\` — ` +
          `the upstream spec changed shape, or the snapshot is stale.`,
      );
    }

    const properties: ParsedProperty[] = [];
    const attributes: Array<{ name: string; tsType: string }> = [];

    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const isAttribute =
        prop.readOnly === true || ENVELOPE_ATTRIBUTES.has(name) || FORCED_ATTRIBUTES.has(`${kind.kind}:${name}`);

      const ctx: WalkContext = { schemas, propertyTypes, inProgress, kind };
      const tsType = resolveType(prop, ctx, kind.className + segment(name), `${kind.kind}:${name}`, 0, isAttribute);

      if (isAttribute) {
        if (!RESERVED_ATTRIBUTE_NAMES.has(name)) attributes.push({ name, tsType });
        continue;
      }

      properties.push({
        name,
        tsType,
        required: (schema.required ?? []).includes(name) || FORCED_REQUIRED.has(name) || FORCED_REQUIRED.has(`${kind.kind}:${name}`),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }

    if (kind.gvcScoped) {
      // Replace rather than append: `identity` and `volumeset` already declare
      // a `gvc` of their own, in two different shapes. One normalized property
      // beats three near-identical ones.
      const existing = properties.findIndex((p) => p.name === "gvc");
      if (existing >= 0) properties.splice(existing, 1);
      properties.push({ ...SYNTHETIC_GVC_PROP });
    }

    results.push({
      resource: { typeName: kind.typeName, description: kind.summary, properties, attributes },
      propertyTypes: [],
      enums: [],
    });
  }

  for (const [className, resource] of [...propertyTypes].sort(([a], [b]) => a.localeCompare(b))) {
    results.push({
      resource: { ...resource, typeName: `${NAMESPACE}::${SERVICE}::${className}` },
      propertyTypes: [],
      enums: [],
      isProperty: true,
    });
  }

  return results;
}

// ── Type resolution ────────────────────────────────────────────────

interface WalkContext {
  schemas: Record<string, OpenAPISchema>;
  propertyTypes: Map<string, ParsedResource>;
  inProgress: Set<string>;
  kind: CplnKind;
}

/**
 * Resolve a schema node to a TypeScript type, emitting property-type classes
 * for the object shapes it reaches.
 *
 * `className` is the name an inline object at this position would take;
 * `path` is the `<kind>:<dotted path>` used to consult {@link LOOSENED_PATHS}.
 * `readOnlyBranch` suppresses class emission under a read-only subtree —
 * `status` trees are reported back as plain data, and typing them would double
 * this lexicon's surface for shapes nobody authors.
 */
function resolveType(
  node: OpenAPISchema | undefined,
  ctx: WalkContext,
  className: string,
  path: string,
  depth: number,
  readOnlyBranch: boolean,
): string {
  if (!node || depth > MAX_DEPTH) return "Record<string, unknown>";

  if (LOOSENED_PATHS.has(path)) return "Record<string, unknown>";

  const override = TYPE_OVERRIDES.get(path);
  if (override) return override;

  // A `$ref` adopts the upstream schema's name, so a shape shared between two
  // kinds is emitted once rather than once per path that reaches it.
  if (node.$ref) {
    const refName = refTarget(node.$ref);
    if (!refName) return "Record<string, unknown>";
    const target = ctx.schemas[refName];
    if (!target) return "Record<string, unknown>";
    return resolveType(target, ctx, schemaClassName(refName), path, depth + 1, readOnlyBranch);
  }

  // `allOf: [{ $ref }]` — the OpenAPI idiom for "typed as this schema".
  if (node.allOf?.length) {
    const withRef = node.allOf.find((s) => s.$ref);
    if (withRef) return resolveType(withRef, ctx, className, path, depth + 1, readOnlyBranch);
  }

  const union = node.oneOf ?? node.anyOf;
  if (union?.length) {
    // Named branches keep their type; inline object branches collapse to a map.
    // The only union of consequence is `secret.data`, whose named branches are
    // the six documented secret payloads and whose inline branches are
    // provider-specific credential bags — a union of six anonymous
    // `SecretDataVariant3`-style classes would be worse than one honest map.
    const members = union.map((branch) =>
      branch.$ref
        ? resolveType(branch, ctx, className, path, depth + 1, readOnlyBranch)
        : branch.properties
          ? "Record<string, unknown>"
          : resolveType(branch, ctx, className, path, depth + 1, readOnlyBranch),
    );
    return dedupeUnion(members);
  }

  if (node.enum?.length) return enumUnion(node.enum);

  const kind = primaryType(node.type);

  if (kind === "array") {
    // An array contributes no name segment: `containers[]` and `containers`
    // describe the same shape.
    const item = resolveType(node.items, ctx, className, path, depth + 1, readOnlyBranch);
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }

  if (kind === "object" || (!node.type && node.properties)) {
    if (node.properties && Object.keys(node.properties).length > 0) {
      if (readOnlyBranch) return "Record<string, unknown>";
      return emitPropertyType(node, ctx, className, path, depth);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      const value = resolveType(node.additionalProperties, ctx, className, path, depth + 1, readOnlyBranch);
      return `Record<string, ${value}>`;
    }
    return "Record<string, unknown>";
  }

  switch (kind) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "Record<string, unknown>";
  }
}

/**
 * Register (or reuse) a property-type class for an object schema and return
 * its class name.
 */
function emitPropertyType(
  node: OpenAPISchema,
  ctx: WalkContext,
  className: string,
  path: string,
  depth: number,
): string {
  if (ctx.propertyTypes.has(className)) return className;

  // A `$ref` cycle would otherwise recurse forever. The spec has none today;
  // this makes adding one a loose type rather than a hung generator.
  if (ctx.inProgress.has(className)) return className;
  ctx.inProgress.add(className);

  const required = new Set(node.required ?? []);
  const properties: ParsedProperty[] = [];

  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    if (prop.readOnly === true) continue;
    properties.push({
      name,
      tsType: resolveType(prop, ctx, className + segment(name), `${path}.${name}`, depth + 1, false),
      required: required.has(name),
      description: prop.description,
      constraints: coreExtractConstraints(prop as JsonSchemaProperty),
    });
  }

  ctx.inProgress.delete(className);
  ctx.propertyTypes.set(className, {
    typeName: className,
    description: node.description,
    properties,
    attributes: [],
  });

  return className;
}

// ── Naming helpers ─────────────────────────────────────────────────

/**
 * Upstream schema names that read better with their internal word boundary
 * restored. `volumeset` and `ipset` are one lowercase token in the API and two
 * words everywhere in Control Plane's own documentation.
 */
const SCHEMA_NAME_ALIASES: Record<string, string> = {
  volumeset: "VolumeSet",
  ipset: "IpSet",
};

/** `volumeset_spec` → `VolumeSetSpec`, `policy_binding` → `PolicyBinding`. */
export function schemaClassName(schemaName: string): string {
  return schemaName
    .split("_")
    .map((part) => SCHEMA_NAME_ALIASES[part] ?? segment(part))
    .join("");
}

/** `readinessProbe` → `ReadinessProbe`; strips anything not identifier-safe. */
function segment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, "");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** `#/components/schemas/query` → `query`. */
function refTarget(ref: string): string | undefined {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined;
}

/** Render an enum as a sorted string-literal union. */
function enumUnion(values: unknown[]): string {
  return [...values]
    .map((v) => JSON.stringify(v))
    .sort()
    .join(" | ");
}

/** Collapse duplicate union members, preserving first-seen order. */
function dedupeUnion(members: string[]): string {
  const unique = [...new Set(members)];
  return unique.length === 0 ? "Record<string, unknown>" : unique.join(" | ");
}
