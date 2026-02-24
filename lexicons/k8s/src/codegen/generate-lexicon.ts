/**
 * Lexicon JSON generator — produces lexicon-k8s.json with metadata
 * for all Kubernetes resource and property types.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { K8sParseResult } from "../spec/parse";
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
      return entry;
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "k8s" as const,
    }),
  });

  return serializeRegistry(entries);
}
