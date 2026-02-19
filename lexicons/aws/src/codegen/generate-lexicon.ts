/**
 * Lexicon JSON generator — produces lexicon-aws.json with metadata for all resources.
 *
 * Output is a Record<string, LexiconEntry> keyed by generated class name.
 */

import type { SchemaParseResult } from "../spec/parse";
import { cfnShortName } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import type { ExtensionConstraint } from "./extensions";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "aws";
  attrs?: Record<string, string>;
  constraints?: ExtensionConstraint[];
  propertyConstraints?: Record<string, PropertyConstraints>;
  createOnly?: string[];
  writeOnly?: string[];
  primaryIdentifier?: string[];
  runtimeDeprecations?: Record<string, string>;
}

/**
 * Generate the lexicon-aws.json content.
 */
export function generateLexiconJSON(
  results: SchemaParseResult[],
  naming: NamingStrategy,
  constraints: Map<string, ExtensionConstraint[]>,
  runtimeDeprecations: Record<string, string> | null,
): string {
  // Adapt SchemaParseResult[] to RegistryResource[]
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes,
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: cfnShortName,
    buildEntry: (resource, _tsName, attrs, propConstraints) => {
      const cfnType = resource.typeName;
      const r = results.find((res) => res.resource.typeName === cfnType)!;

      // Runtime deprecation data for Lambda resources with Runtime property
      let runtimeDepr: Record<string, string> | undefined;
      if (runtimeDeprecations && r.resource.properties.some((p) => p.name === "Runtime")) {
        runtimeDepr = runtimeDeprecations;
      }

      return {
        resourceType: cfnType,
        kind: "resource" as const,
        lexicon: "aws" as const,
        ...(attrs && { attrs }),
        ...(constraints.has(cfnType) && { constraints: constraints.get(cfnType) }),
        ...(propConstraints && { propertyConstraints: propConstraints }),
        ...(r.resource.createOnly.length > 0 && { createOnly: r.resource.createOnly }),
        ...(r.resource.writeOnly.length > 0 && { writeOnly: r.resource.writeOnly }),
        ...(r.resource.primaryIdentifier.length > 0 && { primaryIdentifier: r.resource.primaryIdentifier }),
        ...(runtimeDepr && { runtimeDeprecations: runtimeDepr }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "aws" as const,
    }),
  });

  return serializeRegistry(entries);
}

/**
 * Lambda runtime deprecation fallback data.
 */
export function lambdaRuntimeDeprecations(): Record<string, string> {
  return {
    "nodejs14.x": "deprecated",
    "nodejs16.x": "deprecated",
    "nodejs18.x": "approaching_eol",
    "python3.7": "deprecated",
    "python3.8": "deprecated",
    "python3.9": "approaching_eol",
    "dotnet6": "deprecated",
    "java8": "deprecated",
    "ruby2.7": "deprecated",
  };
}
