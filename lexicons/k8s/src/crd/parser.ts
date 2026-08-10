/**
 * CRD parser — converts CRD YAML into K8sParseResult entries.
 *
 * Parses the openAPIV3Schema from a CRD's versions to extract resource
 * properties, building the same K8sParseResult structures used by the
 * main K8s swagger parser. This enables CRD-based resources to integrate
 * with the full codegen pipeline.
 */

import type { K8sParseResult, ParsedProperty, ParsedPropertyType, GroupVersionKind } from "../spec/parse";
import type { CRDSpec } from "./types";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import { loadAll } from "js-yaml";

/**
 * Group names whose first segment doesn't yield the conventional namespace.
 * "argoproj.io" → "Argo" (not "Argoproj") to match the Argo CD vocabulary
 * and the ArgoAppFor / ArgoAppSetForRegions composites.
 *
 * The Flux toolkit spreads across five `*.toolkit.fluxcd.io` groups plus the
 * Flux Operator's `fluxcd.controlplane.io`; all six collapse to a single `Flux`
 * namespace so a GitRepository and a Kustomization read as `K8s::Flux::*`
 * siblings rather than scattering to Source / Kustomize / Helm / Notification /
 * Image / Fluxcd. (`helm.toolkit.fluxcd.io` → `Helm` would also collide
 * confusingly with the separate helm lexicon.)
 *
 * KubeMicroVM's `lambda.aws.amazon.com` would take `Lambda` by the
 * first-segment rule, which reads as AWS Lambda proper and would sit
 * confusingly beside the aws lexicon's real Lambda functions. These are
 * Kubernetes CRs belonging to a community operator, so they take the
 * operator's own name. `MicroVM` alone was the alternative and was rejected
 * for stuttering: `K8s::MicroVM::MicroVM`.
 *
 * Note the official AWS controller uses a different group,
 * `lambdamicrovms.services.k8s.aws`, so it can coexist here and will want its
 * own entry rather than sharing this one.
 */
const GROUP_NAMESPACE_OVERRIDES: Record<string, string> = {
  "argoproj.io": "Argo",
  "source.toolkit.fluxcd.io": "Flux",
  "kustomize.toolkit.fluxcd.io": "Flux",
  "helm.toolkit.fluxcd.io": "Flux",
  "notification.toolkit.fluxcd.io": "Flux",
  "image.toolkit.fluxcd.io": "Flux",
  "fluxcd.controlplane.io": "Flux",
  "lambda.aws.amazon.com": "KubeMicroVM",
  // CNPG and its barman-cloud plugin ship under two groups but are one thing to
  // an author: a Cluster's `plugins[]` names an ObjectStore. The first-segment
  // rule would scatter them into `Postgresql` and `Barmancloud`.
  "postgresql.cnpg.io": "Cnpg",
  "barmancloud.cnpg.io": "Cnpg",
  // Not `Secrets`: `K8s::Secrets::InfisicalSecret` reads like a core Secret,
  // and `K8s::Core::Secret` is right there to be confused with.
  "secrets.infisical.com": "Infisical",
  // k3s's bundled controllers ship under two groups but are one thing to an
  // author — the k3s auto-deploy surface. The first-segment rule would give
  // `K8s::Helm::HelmChart`, which reads like it belongs to the helm lexicon,
  // and would split HelmChart from the Addon that tracks its deployment.
  "helm.cattle.io": "K3s",
  "k3s.cattle.io": "K3s",
};

/**
 * Normalize a CRD group to a PascalCase namespace segment.
 * "cert-manager.io" → "CertManager"
 * "monitoring.coreos.com" → "Monitoring"
 * "argoproj.io" → "Argo" (override)
 */
function normalizeGroupName(group: string): string {
  const override = GROUP_NAMESPACE_OVERRIDES[group];
  if (override) return override;
  // Take the first segment before the first dot
  const firstSegment = group.split(".")[0];
  // Convert kebab-case to PascalCase
  return firstSegment
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Parse a CRD YAML document string into K8sParseResult entries.
 * Returns one result per served version in the CRD.
 */
export function parseCRD(content: string): K8sParseResult[] {
  const results: K8sParseResult[] = [];

  // Use js-yaml to handle full YAML spec (CRD YAMLs use same-indent arrays,
  // nested block scalars, and deep nesting not supported by the lightweight parser).
  const documents: unknown[] = [];
  loadAll(content, (doc) => documents.push(doc));

  for (const doc of documents) {
    if (!doc || typeof doc !== "object") continue;
    const docObj = doc as Record<string, unknown>;
    if (docObj.kind !== "CustomResourceDefinition") continue;

    const spec = docObj.spec as CRDSpec | undefined;
    if (!spec?.group || !spec?.names?.kind || !spec?.versions) continue;

    const crdResults = parseCRDSpec(spec);
    results.push(...crdResults);
  }

  return results;
}

/**
 * Parse a CRD spec into K8sParseResult entries.
 * Extracts one result per served version with storage version preferred.
 */
export function parseCRDSpec(spec: CRDSpec): K8sParseResult[] {
  const results: K8sParseResult[] = [];
  const groupNs = normalizeGroupName(spec.group);

  // Find the storage version (the canonical version)
  const storageVersion = spec.versions.find((v) => v.storage && v.served);
  // Fall back to any served version
  const targetVersion = storageVersion ?? spec.versions.find((v) => v.served);

  if (!targetVersion) return results;

  const typeName = `K8s::${groupNs}::${spec.names.kind}`;
  const gvk: GroupVersionKind = {
    group: spec.group,
    version: targetVersion.name,
    kind: spec.names.kind,
  };

  const schema = targetVersion.schema?.openAPIV3Schema as OpenAPISchema | undefined;
  const properties = schema ? extractProperties(schema) : [];
  const propertyTypes = schema ? extractPropertyTypes(schema, typeName) : [];
  const status = schema ? extractStatusType(schema, typeName) : {};

  const attributes = [
    { name: "name", tsType: "string" },
    { name: "namespace", tsType: "string" },
    { name: "uid", tsType: "string" },
  ];
  if (status.attribute) attributes.push(status.attribute);

  results.push({
    resource: {
      typeName,
      description: `Custom resource: ${spec.names.kind} (${spec.group})`,
      properties,
      attributes,
      deprecatedProperties: [],
    },
    propertyTypes: status.propertyType ? [...propertyTypes, status.propertyType] : propertyTypes,
    enums: [],
    gvk,
    // chant #1074 — the CRD declares its own plural and scope, so the
    // operation surface for a custom resource comes from the same document its
    // types do, exactly as the OpenAPI `paths` supply them for built-in kinds.
    operation: {
      plural: spec.names.plural,
      scope: spec.scope ?? "Namespaced",
      verbs: ["delete", "get", "list", "patch", "post", "put", "watch"],
    },
  });

  return results;
}

// ── OpenAPI schema types ────────────────────────────────────────────

interface OpenAPISchema {
  type?: string;
  description?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  additionalProperties?: boolean | OpenAPISchema;
  enum?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  "x-kubernetes-int-or-string"?: boolean;
}

// ── Property extraction ─────────────────────────────────────────────

/**
 * Extract top-level properties from a CRD's openAPIV3Schema.
 * Focuses on the "spec" sub-object and metadata, skipping status.
 */
function extractProperties(schema: OpenAPISchema): ParsedProperty[] {
  const result: ParsedProperty[] = [];
  const topProps = schema.properties ?? {};
  const topRequired = new Set<string>(schema.required ?? []);

  // Skip apiVersion, kind, status — same pattern as core parser. `metadata` is
  // skipped here too and re-added below: every custom resource carries the full
  // ObjectMeta whatever its own schema says, and most CRD schemas say nothing.
  const skipProps = new Set(["apiVersion", "kind", "metadata", "status"]);

  // A CRD's openAPIV3Schema describes what the *controller* reads, so authors
  // routinely declare only `spec` and `status` — the Fabric8 CRDGenerator emits
  // exactly that, and so do most hand-written CRDs. The API server still accepts
  // (and requires) the standard `metadata`, so deriving the constructor surface
  // from the schema alone produced a class with no way to set a name or
  // namespace, and every call site needed an `as any` to get one on. Emit it
  // unconditionally, typed the same as every built-in kind's.
  result.push({
    name: "metadata",
    tsType: "ObjectMeta",
    required: false,
    description: "Standard object's metadata.",
    constraints: {},
  });

  for (const [name, prop] of Object.entries(topProps)) {
    if (skipProps.has(name)) continue;

    result.push({
      name,
      tsType: resolveSchemaType(prop),
      required: topRequired.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: extractConstraints(prop),
    });
  }

  return result;
}

/**
 * Extract nested object types as ParsedPropertyType entries.
 * Walks the spec's properties looking for inline object definitions.
 */
function extractPropertyTypes(schema: OpenAPISchema, parentTypeName: string): ParsedPropertyType[] {
  const results: ParsedPropertyType[] = [];
  const specSchema = schema.properties?.spec;
  if (!specSchema?.properties) return results;

  // Use the short name (last :: segment) as prefix so the naming pipeline
  // produces valid TS identifiers: "RayCluster_AutoscalerOptions" not
  // "K8s::Ray::RayCluster::AutoscalerOptions".
  const shortName = parentTypeName.split("::").pop()!;

  // Property-type identifiers must be unique within a resource. Singularizing
  // array names can collide a sibling scalar object — e.g. Argo Application has
  // both `source` (object) and `sources` (array), which both reduce to
  // `Application_Source`. Track emitted names and fall back to the raw
  // (un-singularized) name, then a numeric suffix, on collision.
  const usedNames = new Set<string>();
  const uniqueName = (base: string, raw: string): string => {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const rawCandidate = `${shortName}_${pascalCase(raw)}`;
    if (!usedNames.has(rawCandidate)) {
      usedNames.add(rawCandidate);
      return rawCandidate;
    }
    let i = 2;
    while (usedNames.has(`${base}${i}`)) i++;
    const suffixed = `${base}${i}`;
    usedNames.add(suffixed);
    return suffixed;
  };

  for (const [name, prop] of Object.entries(specSchema.properties)) {
    // Extract inline object definitions as property types
    if (prop.type === "object" && prop.properties) {
      const ptName = uniqueName(`${shortName}_${pascalCase(name)}`, name);
      const requiredSet = new Set<string>(prop.required ?? []);

      results.push({
        name: ptName,
        defType: name,
        properties: Object.entries(prop.properties).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
        })),
      });
    }

    // Array of objects
    if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
      const itemSchema = prop.items;
      const itemProps = itemSchema.properties!;
      const ptName = uniqueName(`${shortName}_${pascalCase(singularize(name))}`, name);
      const requiredSet = new Set<string>(itemSchema.required ?? []);

      results.push({
        name: ptName,
        defType: name,
        properties: Object.entries(itemProps).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
        })),
      });
    }
  }

  return results;
}

/**
 * Extract the read-only `status` sub-object as a property type plus a `status`
 * attribute on the resource. Status is never part of the writable spec surface
 * (it is server-owned), so it is exposed only as a read-only output.
 *
 * Shallow by design, mirroring extractPropertyTypes: scalar leaves are typed,
 * nested objects and arrays-of-objects degrade to `Record<string, any>`. Status
 * with `x-kubernetes-preserve-unknown-fields` (or no properties) degrades to a
 * bare `Record<string, any>` attribute with no property type.
 */
function extractStatusType(
  schema: OpenAPISchema,
  parentTypeName: string,
): { attribute?: { name: string; tsType: string }; propertyType?: ParsedPropertyType } {
  const statusSchema = schema.properties?.status;
  if (!statusSchema) return {};

  // The `.d.ts` accessor is deliberately opaque — CRD typing lives in the
  // lexicon JSON (the same channel `spec` uses, which is also `Record<string,
  // unknown>` in the constructor). The rich, per-field status shape is carried
  // by the property type below, surfaced through LSP / validation / MCP.
  const attribute = { name: "status", tsType: "Record<string, unknown>" };

  // Opaque status (preserve-unknown or no schema) → read-only record only.
  if (statusSchema["x-kubernetes-preserve-unknown-fields"] || !statusSchema.properties) {
    return { attribute };
  }

  const shortName = parentTypeName.split("::").pop()!;
  const propertyType: ParsedPropertyType = {
    name: `${shortName}_Status`,
    defType: "status",
    properties: Object.entries(statusSchema.properties).map(([pName, pSchema]) => ({
      name: pName,
      tsType: resolveSchemaType(pSchema),
      required: new Set<string>(statusSchema.required ?? []).has(pName),
      description: pSchema.description,
      enum: pSchema.enum,
      constraints: extractConstraints(pSchema),
    })),
  };

  return { attribute, propertyType };
}

/**
 * Resolve an OpenAPI schema node to a TypeScript type string.
 */
function resolveSchemaType(schema: OpenAPISchema): string {
  if (!schema) return "any";

  if (schema["x-kubernetes-int-or-string"]) return "string | number";
  if (schema["x-kubernetes-preserve-unknown-fields"]) return "Record<string, any>";

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items) {
        const itemType = resolveSchemaType(schema.items);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object":
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const valueType = resolveSchemaType(schema.additionalProperties);
        return `Record<string, ${valueType}>`;
      }
      if (schema.properties) return "Record<string, any>"; // will be a property type
      return "Record<string, any>";
    default:
      return "any";
  }
}

/**
 * Extract property constraints from an OpenAPI schema node.
 */
function extractConstraints(schema: OpenAPISchema): PropertyConstraints {
  const constraints: PropertyConstraints = {};
  if (schema.minimum !== undefined) constraints.minimum = schema.minimum;
  if (schema.maximum !== undefined) constraints.maximum = schema.maximum;
  if (schema.minLength !== undefined) constraints.minLength = schema.minLength;
  if (schema.maxLength !== undefined) constraints.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) constraints.pattern = schema.pattern;
  return constraints;
}

/**
 * Convert a string to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .split(/[-_.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Naive singularize — removes trailing "s" for property type naming.
 */
function singularize(str: string): string {
  if (str.endsWith("ies")) return str.slice(0, -3) + "y";
  if (str.endsWith("ses")) return str.slice(0, -2);
  if (str.endsWith("s") && !str.endsWith("ss")) return str.slice(0, -1);
  return str;
}
