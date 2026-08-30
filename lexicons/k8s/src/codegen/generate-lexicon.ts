/**
 * Lexicon JSON generator — produces lexicon-k8s.json with metadata
 * for all Kubernetes resource and property types.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { K8sParseResult, CrdFieldSchema } from "../spec/parse";
import { k8sShortName, gvkToApiVersion } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface K8sLexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "k8s";
  apiVersion?: string;
  gvkKind?: string;
  deprecatedProperties?: string[];
  constraints?: Record<string, PropertyConstraints>;
  /**
   * Field schema of a custom resource's `spec` (chant #1372). Only CRD-derived
   * kinds carry one; built-in kinds are typed by the `.d.ts`. Consumed by the
   * WK8501/WK8502 post-synth checks and the MCP catalog.
   */
  specSchema?: CrdFieldSchema;
}

/**
 * Generate the lexicon-k8s.json content.
 */
export function generateLexiconJSON(
  results: K8sParseResult[],
  naming: NamingStrategy,
): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes.map((pt) => ({ name: pt.name, specType: pt.defType })),
  }));

  const entries = buildRegistry<K8sLexiconEntry>(registryResources, naming, {
    shortName: k8sShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      const entry: K8sLexiconEntry = {
        resourceType: resource.typeName,
        kind: (r?.isProperty ? "property" : "resource") as "resource" | "property",
        lexicon: "k8s" as const,
      };
      if (r && !r.isProperty) {
        entry.apiVersion = gvkToApiVersion(r.gvk);
        entry.gvkKind = r.gvk.kind;
      }
      if (r?.resource.deprecatedProperties?.length) {
        entry.deprecatedProperties = r.resource.deprecatedProperties;
      }
      if (propConstraints && Object.keys(propConstraints).length > 0) {
        entry.constraints = propConstraints;
      }
      if (r?.specSchema) {
        entry.specSchema = r.specSchema;
      }
      return entry;
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "k8s" as const,
    }),
  });

  return serializeWithCompactSchemas(entries);
}

/**
 * Pretty-print the registry the way every lexicon does, but keep each
 * `specSchema` on one line (chant #1372). A CRD schema nests deeply — an
 * ApplicationSet or RayCluster embeds a whole PodTemplateSpec — and two-space
 * indentation on that tree quadruples the file for no reader's benefit.
 * Compact, the schemas add ~0.8 MB to the registry; pretty, ~3.9 MB.
 */
export function serializeWithCompactSchemas(entries: Record<string, K8sLexiconEntry>): string {
  const compact = new Map<string, string>();
  const stripped: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry.specSchema) {
      stripped[name] = entry;
      continue;
    }
    const { specSchema, ...rest } = entry;
    const token = `__chant_spec_schema_${compact.size}__`;
    compact.set(token, JSON.stringify(specSchema));
    stripped[name] = { ...rest, specSchema: token };
  }
  let out = serializeRegistry(stripped);
  for (const [token, json] of compact) {
    out = out.replace(`"${token}"`, json);
  }
  return out;
}
