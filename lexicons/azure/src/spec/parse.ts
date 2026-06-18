/**
 * Azure Resource Manager JSON Schema parser.
 *
 * Parses each exploded ARM schema into typed structures suitable for code generation:
 * resources with properties and attributes, property types from definitions,
 * and enum types from string enum definitions.
 *
 * Key differences from CloudFormation parsing:
 * - ARM has resource-level fields (name, type, apiVersion, location, sku, kind,
 *   identity, tags, zones, plan) separate from properties.properties
 * - ARM schemas use oneOf wrappers with expression refs that must be unwrapped
 * - ARM schemas lack readOnlyProperties — attributes are curated
 */

import type { ArmResourceDefinition, ArmSchemaProperty, ArmSchemaDefinition } from "./fetch";
import {
  resolvePropertyType as coreResolvePropertyType,
  extractConstraints as coreExtractConstraints,
  constraintsIsEmpty as coreConstraintsIsEmpty,
  isEnumDefinition as coreIsEnumDefinition,
  type PropertyConstraints,
  type JsonSchemaDocument,
  type JsonSchemaProperty,
  type JsonSchemaDefinition,
} from "@intentius/chant/codegen/json-schema";

export type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedAttribute {
  name: string;
  tsType: string;
}

export interface ParsedPropertyType {
  name: string;
  specType: string;
  properties: ParsedProperty[];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

export interface ParsedResource {
  typeName: string;
  apiVersion: string;
  properties: ParsedProperty[];
  attributes: ParsedAttribute[];
  resourceLevelFields: string[];
  tagging?: { taggable: boolean; tagOnCreate: boolean; tagUpdatable: boolean };
}

export interface ArmSchemaParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
}

/** ARM resource-level fields that live outside properties.properties. */
const RESOURCE_LEVEL_FIELDS = new Set([
  "name",
  "type",
  "apiVersion",
  "location",
  "sku",
  "kind",
  "identity",
  "tags",
  "zones",
  "plan",
]);

/** Expression reference pattern in ARM oneOf wrappers. */
const EXPRESSION_REF_PATTERN =
  /definitions\.json#\/definitions\/expression|common\/definitions\.json/;

/**
 * Curated attributes for common ARM resources.
 * ARM schemas lack readOnlyProperties, so we maintain this list.
 */
const CURATED_ATTRIBUTES: Record<string, Array<{ name: string; tsType: string }>> = {
  "Microsoft.Storage/storageAccounts": [
    { name: "id", tsType: "string" },
    { name: "primaryEndpoints", tsType: "string" },
    { name: "primaryLocation", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Compute/virtualMachines": [
    { name: "id", tsType: "string" },
    { name: "vmId", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Network/virtualNetworks": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Network/networkSecurityGroups": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Network/publicIPAddresses": [
    { name: "id", tsType: "string" },
    { name: "ipAddress", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Network/networkInterfaces": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Web/serverfarms": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Web/sites": [
    { name: "id", tsType: "string" },
    { name: "defaultHostName", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.ContainerService/managedClusters": [
    { name: "id", tsType: "string" },
    { name: "fqdn", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
    { name: "nodeResourceGroup", tsType: "string" },
  ],
  "Microsoft.Sql/servers": [
    { name: "id", tsType: "string" },
    { name: "fullyQualifiedDomainName", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Sql/servers_databases": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.KeyVault/vaults": [
    { name: "id", tsType: "string" },
    { name: "vaultUri", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.ContainerRegistry/registries": [
    { name: "id", tsType: "string" },
    { name: "loginServer", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.DocumentDB/databaseAccounts": [
    { name: "id", tsType: "string" },
    { name: "documentEndpoint", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
  "Microsoft.Network/loadBalancers": [
    { name: "id", tsType: "string" },
    { name: "provisioningState", tsType: "string" },
  ],
};

/**
 * Maximum nesting depth of generated property-type interfaces.
 *
 * ARM schemas embed a named definition for every nested object, and fully
 * expanding all of them per-resource produces a ~273MB declaration that is not
 * shippable as `.d.ts`. We instead emit only the property types reachable from
 * a resource's top-level properties within this depth; references that are
 * deeper, or to definitions no resource property reaches, are loosened to
 * `Record<string, unknown>`. Depth 1 keeps top-level props + their immediate
 * nested object shapes typed; deeper ARM config trees become loose. (#438)
 */
const MAX_PROPERTY_TYPE_DEPTH = 1;

/**
 * Property-type definition names that are always emitted as typed interfaces,
 * regardless of reachability/depth — common nested ARM shapes worth typing for
 * authoring ergonomics. Kept in sync with the azure `validate` required-names
 * check (it asserts these survive code generation). (#438)
 */
export const CURATED_PROPERTY_TYPE_DEFS = new Set<string>([
  "Sku",
  "Identity",
  "NetworkProfile",
  "StorageProfile",
  "OsDisk",
  "ImageReference",
  "IpConfiguration",
  "SecurityRule",
  "SubnetProperties",
  "SiteConfig",
]);

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract `${shortName}_Ident` type-reference tokens from a tsType string. */
function referencedTypeNames(tsType: string, shortName: string): string[] {
  const re = new RegExp("\\b" + escapeRegExp(shortName) + "_[A-Za-z0-9_]+", "g");
  return tsType.match(re) ?? [];
}

/**
 * Bound the set of emitted property types to those reachable from a resource's
 * top-level properties within {@link MAX_PROPERTY_TYPE_DEPTH}. Property-type
 * references that fall outside the emitted set are rewritten to
 * `Record<string, unknown>` (enum references are preserved). Mutates the
 * tsType of `resourceProps` and the retained property types in place; returns
 * the retained property types. (#438)
 */
function boundPropertyTypes(
  shortName: string,
  resourceProps: ParsedProperty[],
  propertyTypes: ParsedPropertyType[],
  enumNames: Set<string>,
  maxDepth: number,
): ParsedPropertyType[] {
  const byName = new Map(propertyTypes.map((pt) => [pt.name, pt]));
  const reached = new Set<string>();
  const queue: Array<{ name: string; depth: number }> = [];

  const seed = (tsType: string, depth: number) => {
    for (const n of referencedTypeNames(tsType, shortName)) {
      if (byName.has(n) && !reached.has(n)) {
        reached.add(n);
        queue.push({ name: n, depth });
      }
    }
  };

  for (const p of resourceProps) seed(p.tsType, 1);
  // Force-keep curated property types as depth-1 seeds so important nested ARM
  // shapes stay typed regardless of reachability/depth. Matched by substring so
  // schema variant names (e.g. "SecurityRulePropertiesFormat") are retained (#438).
  const curated = [...CURATED_PROPERTY_TYPE_DEFS];
  for (const pt of propertyTypes) {
    if (!reached.has(pt.name) && curated.some((c) => pt.specType.includes(c))) {
      reached.add(pt.name);
      queue.push({ name: pt.name, depth: 1 });
    }
  }
  while (queue.length) {
    const { name, depth } = queue.shift()!;
    if (depth >= maxDepth) continue; // do not expand children beyond the cap
    const pt = byName.get(name);
    if (!pt) continue;
    for (const p of pt.properties) seed(p.tsType, depth + 1);
  }

  // Rewrite references to property types we are not emitting (keep enums).
  const loosen = (tsType: string): string => {
    let out = tsType;
    for (const n of referencedTypeNames(tsType, shortName)) {
      if (reached.has(n) || enumNames.has(n) || !byName.has(n)) continue;
      out = out.replace(new RegExp("\\b" + escapeRegExp(n) + "\\b", "g"), "Record<string, unknown>");
    }
    return out;
  };

  for (const p of resourceProps) p.tsType = loosen(p.tsType);
  const retained: ParsedPropertyType[] = [];
  for (const pt of propertyTypes) {
    if (!reached.has(pt.name)) continue;
    for (const p of pt.properties) p.tsType = loosen(p.tsType);
    retained.push(pt);
  }
  return retained;
}

/**
 * Parse an ARM schema (exploded per-resource format) into typed structures.
 */
export function parseArmSchema(data: string | Buffer): ArmSchemaParseResult {
  const raw = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));

  const resourceType: string = raw.resourceType;
  const apiVersion: string = raw.apiVersion;
  const resourceDef: ArmResourceDefinition = raw.resourceDefinition;
  const definitions: Record<string, ArmSchemaDefinition> = raw.definitions ?? {};

  const shortName = armShortName(resourceType);
  const fakeSchema = { definitions } as unknown as { typeName: string; definitions?: Record<string, ArmSchemaDefinition> };

  // Parse resource-level fields and nested properties
  const props: ParsedProperty[] = [];
  const resourceLevelFields: string[] = [];

  if (resourceDef.properties) {
    for (const [name, prop] of Object.entries(resourceDef.properties)) {
      if (name === "type" || name === "apiVersion") continue; // These are injected

      const unwrapped = unwrapExpressionOneOf(prop);

      if (RESOURCE_LEVEL_FIELDS.has(name)) {
        resourceLevelFields.push(name);
      }

      // If this is the "properties" container, expand its sub-properties
      if (name === "properties" && unwrapped.properties) {
        const innerRequired = new Set<string>(unwrapped.required ?? []);
        for (const [innerName, innerProp] of Object.entries(unwrapped.properties)) {
          const innerUnwrapped = unwrapExpressionOneOf(innerProp);
          const tsType = resolvePropertyType(innerUnwrapped, definitions, shortName);
          props.push({
            name: innerName,
            tsType,
            required: innerRequired.has(innerName),
            description: innerUnwrapped.description,
            enum: innerUnwrapped.enum,
            constraints: extractConstraints(innerUnwrapped),
          });
        }
        continue;
      }

      const tsType = resolvePropertyType(unwrapped, definitions, shortName);
      const requiredSet = new Set<string>(resourceDef.required ?? []);
      props.push({
        name,
        tsType,
        required: requiredSet.has(name),
        description: unwrapped.description,
        enum: unwrapped.enum,
        constraints: extractConstraints(unwrapped),
      });
    }
  }

  // Parse definitions into property types and enums
  const propertyTypes: ParsedPropertyType[] = [];
  const enums: ParsedEnum[] = [];

  for (const [defName, def] of Object.entries(definitions)) {
    // Skip expression-related definitions
    if (defName === "expression" || defName.startsWith("http")) continue;

    if (isEnumDefinition(def)) {
      enums.push({
        name: `${shortName}_${defName}`,
        values: def.enum!,
      });
      continue;
    }

    if (def.properties) {
      const defRequired = new Set<string>(def.required ?? []);
      const defProps: ParsedProperty[] = [];
      for (const [propName, prop] of Object.entries(def.properties)) {
        const unwrapped = unwrapExpressionOneOf(prop);
        const tsType = resolvePropertyType(unwrapped, definitions, shortName);
        defProps.push({
          name: propName,
          tsType,
          required: defRequired.has(propName),
          description: unwrapped.description,
          enum: unwrapped.enum,
          constraints: extractConstraints(unwrapped),
        });
      }
      propertyTypes.push({
        name: `${shortName}_${defName}`,
        specType: defName,
        properties: defProps,
      });
    }
  }

  // Attributes from curated map
  const attrs = CURATED_ATTRIBUTES[resourceType] ?? [
    { name: "id", tsType: "string" },
  ];

  // Bound the emitted property types to keep the generated declaration shippable (#438).
  const boundedPropertyTypes = boundPropertyTypes(
    shortName,
    props,
    propertyTypes,
    new Set(enums.map((e) => e.name)),
    MAX_PROPERTY_TYPE_DEPTH,
  );

  // Detect tagging support (if tags field exists)
  const hasTags = resourceLevelFields.includes("tags");
  const tagging = hasTags
    ? { taggable: true, tagOnCreate: true, tagUpdatable: true }
    : undefined;

  return {
    resource: {
      typeName: resourceType,
      apiVersion,
      properties: props,
      attributes: attrs,
      resourceLevelFields,
      ...(tagging && { tagging }),
    },
    propertyTypes: boundedPropertyTypes,
    enums,
  };
}

// --- Unwrap oneOf expression wrappers ---

/**
 * ARM schemas wrap real types in oneOf with an expression $ref.
 * Detect this pattern and return the real type.
 */
function unwrapExpressionOneOf(prop: ArmSchemaProperty): ArmSchemaProperty {
  if (!prop.oneOf || prop.oneOf.length < 2) return prop;

  const nonExpr = (prop.oneOf as ArmSchemaProperty[]).filter((item) => {
    if (item.$ref && EXPRESSION_REF_PATTERN.test(item.$ref)) return false;
    return true;
  });

  if (nonExpr.length === 1) {
    // Merge description from parent if present
    const result = { ...nonExpr[0] };
    if (prop.description && !result.description) {
      result.description = prop.description;
    }
    return result;
  }

  return prop;
}

// --- Type resolution (delegated to core) ---

function resolvePropertyType(
  prop: ArmSchemaProperty | undefined,
  definitions: Record<string, ArmSchemaDefinition>,
  shortName: string,
): string {
  const fakeDoc = { definitions } as unknown as JsonSchemaDocument;
  return coreResolvePropertyType(
    prop as JsonSchemaProperty | undefined,
    fakeDoc,
    (defName) => `${shortName}_${defName}`,
  );
}

function extractConstraints(prop: ArmSchemaProperty): PropertyConstraints {
  return coreExtractConstraints(prop as JsonSchemaProperty);
}

export const constraintsIsEmpty = coreConstraintsIsEmpty;

function isEnumDefinition(def: ArmSchemaDefinition): boolean {
  return coreIsEnumDefinition(def as JsonSchemaDefinition);
}

/**
 * Extract short resource name:
 * "Microsoft.Storage/storageAccounts" → "storageAccounts"
 */
export function armShortName(typeName: string): string {
  const slashIdx = typeName.lastIndexOf("/");
  return slashIdx >= 0 ? typeName.slice(slashIdx + 1) : typeName;
}

/**
 * Extract service name:
 * "Microsoft.Storage/storageAccounts" → "Storage"
 */
export function armServiceName(typeName: string): string {
  const match = typeName.match(/^Microsoft\.([^/]+)/);
  // Strip dots from hierarchical providers (e.g. "App.ContainerApps" → "AppContainerApps")
  return match ? match[1].replace(/\./g, "") : typeName;
}
