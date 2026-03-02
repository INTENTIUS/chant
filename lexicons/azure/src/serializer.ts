/**
 * Azure Resource Manager template serializer.
 *
 * Converts Declarable entities into ARM template JSON with:
 * - resources[] array (not keyed by logical name like CloudFormation)
 * - apiVersion per resource (from lexicon registry)
 * - Resource-level fields (sku, kind, identity, tags, zones, plan, location)
 *   hoisted from properties
 * - ARM bracket expression references
 * - parameters, outputs sections
 */

import type { Declarable, CoreParameter } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { isChildProject, type ChildProjectInstance } from "@intentius/chant/child-project";
import { isStackOutput, type StackOutput } from "@intentius/chant/stack-output";
import { resolveDependsOn } from "@intentius/chant/resource-attributes";
import { isDefaultTags, type TagEntry } from "./default-tags";
import { loadTaggableResources } from "./taggable";
import { findArmResourceRefs } from "./lint/post-synth/arm-refs";

/** Check if a declarable is a CoreParameter */
function isCoreParameter(entity: Declarable): entity is CoreParameter {
  return "parameterType" in entity;
}

/** ARM template structure */
interface ArmTemplate {
  $schema: string;
  contentVersion: string;
  parameters?: Record<string, ArmParameter>;
  resources: ArmResource[];
  outputs?: Record<string, ArmOutput>;
}

interface ArmParameter {
  type: string;
  metadata?: { description?: string };
  defaultValue?: unknown;
  allowedValues?: unknown[];
}

interface ArmResource {
  type: string;
  apiVersion: string;
  name: string;
  location?: unknown;
  tags?: Record<string, unknown>;
  sku?: unknown;
  kind?: unknown;
  identity?: unknown;
  zones?: unknown;
  plan?: unknown;
  properties?: Record<string, unknown>;
  dependsOn?: string[];
}

interface ArmOutput {
  type: string;
  value: unknown;
}

/** Resource-level fields that get hoisted from properties to resource level. */
const RESOURCE_LEVEL_FIELDS = new Set([
  "location", "tags", "sku", "kind", "identity", "zones", "plan",
]);

/**
 * Load apiVersion for a resource type from the lexicon registry.
 */
function loadApiVersions(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const { readFileSync } = require("fs");
    const { join, dirname } = require("path");
    const { fileURLToPath } = require("url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const lexiconPath = join(dir, "generated", "lexicon-azure.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, { resourceType: string; apiVersion?: string }>;
    for (const entry of Object.values(data)) {
      if (entry.apiVersion && entry.resourceType) {
        map.set(entry.resourceType, entry.apiVersion);
      }
    }
  } catch {
    // Lexicon not available
  }
  return map;
}

/**
 * Override stale apiVersions from the generated registry.
 * These are resource types where the registry apiVersion is known to be
 * too old for modern ARM features (e.g. DataActions on role assignments).
 */
const API_VERSION_OVERRIDES = new Map<string, string>([
  ["Microsoft.Authorization/roleAssignments", "2022-04-01"],
  ["Microsoft.Authorization/roleDefinitions", "2022-04-01"],
]);

let _apiVersions: Map<string, string> | undefined;

function getApiVersion(resourceType: string): string {
  const override = API_VERSION_OVERRIDES.get(resourceType);
  if (override) return override;
  if (!_apiVersions) _apiVersions = loadApiVersions();
  return _apiVersions.get(resourceType) ?? "2023-01-01";
}

/**
 * ARM-specific visitor for the generic serializer walker.
 */
function armVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, attr) => `[reference('${name}').${attr}]`,
    resourceRef: (name) => {
      // Look up the resource type from entityNames
      const entity = [...entityNames.entries()].find(([, n]) => n === name)?.[0];
      if (entity) {
        return `[resourceId('${entity.entityType}', '${name}')]`;
      }
      return `[resourceId('${name}')]`;
    },
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const armProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          armProps[key] = walk(value);
        }
      }
      return Object.keys(armProps).length > 0 ? armProps : undefined;
    },
  };
}

/**
 * Convert a value to ARM-compatible JSON using the generic walker.
 */
function toArmValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, armVisitor(entityNames));
}

/**
 * Serialize entities into an ARM template object.
 */
function serializeToTemplate(
  entities: Map<string, Declarable>,
  outputs?: LexiconOutput[],
): ArmTemplate {
  const template: ArmTemplate = {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    resources: [],
  };

  // Build reverse map: entity -> name
  const entityNames = new Map<Declarable, string>();
  for (const [name, entity] of entities) {
    entityNames.set(entity, name);
  }

  // Collect default tags
  const defaultTagEntries: TagEntry[] = [];
  for (const [, entity] of entities) {
    if (isDefaultTags(entity)) {
      defaultTagEntries.push(...entity.tags);
    }
  }

  // Process entities
  for (const [name, entity] of entities) {
    // Skip non-resource types
    if (isStackOutput(entity) || isDefaultTags(entity)) continue;

    if (isCoreParameter(entity)) {
      if (!template.parameters) template.parameters = {};

      const param: ArmParameter = {
        type: mapParameterType(entity.parameterType),
      };

      if ("description" in entity && typeof entity.description === "string") {
        param.metadata = { description: entity.description };
      }

      if ("defaultValue" in entity && entity.defaultValue !== undefined) {
        param.defaultValue = entity.defaultValue;
      }

      template.parameters[name] = param;
    } else if (isChildProject(entity)) {
      // ChildProjectInstance → linked deployment
      const childProject = entity as ChildProjectInstance;
      const childName = childProject.logicalName;
      const filename = `${childName}.template.json`;

      const resource: ArmResource = {
        type: "Microsoft.Resources/deployments",
        apiVersion: "2021-04-01",
        name: childName,
        properties: {
          mode: "Incremental",
          templateLink: { uri: filename },
        },
      };

      template.resources.push(resource);
    } else if (!isPropertyDeclarable(entity)) {
      const resourceType = entity.entityType;
      // Prefer apiVersion from entity attributes (set by composites) over registry lookup
      const attrs0 = ("attributes" in entity && typeof entity.attributes === "object" && entity.attributes !== null)
        ? entity.attributes as Record<string, unknown>
        : undefined;
      const apiVersion = (typeof attrs0?.apiVersion === "string") ? attrs0.apiVersion : getApiVersion(resourceType);

      const resource: ArmResource = {
        type: resourceType,
        apiVersion,
        name: name,
      };

      // Extract all props
      if ("props" in entity && typeof entity.props === "object" && entity.props !== null) {
        const props = entity.props as Record<string, unknown>;
        const armProperties: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(props)) {
          if (value === undefined) continue;

          if (RESOURCE_LEVEL_FIELDS.has(key)) {
            // Hoist to resource level
            (resource as Record<string, unknown>)[key] = toArmValue(value, entityNames);
          } else if (key === "name") {
            resource.name = toArmValue(value, entityNames) as string;
          } else {
            armProperties[key] = toArmValue(value, entityNames);
          }
        }

        if (Object.keys(armProperties).length > 0) {
          resource.properties = armProperties;
        }
      }

      // Default location to resource group location if not specified
      if (!resource.location) {
        resource.location = "[resourceGroup().location]";
      }

      // Handle DependsOn
      const attrs = ("attributes" in entity && typeof entity.attributes === "object" && entity.attributes !== null)
        ? entity.attributes as Record<string, unknown>
        : undefined;

      if (attrs?.DependsOn !== undefined) {
        const resolved = resolveDependsOn(attrs.DependsOn, entityNames, name);
        if (resolved.length > 0) {
          resource.dependsOn = resolved.map((dep) => {
            // Convert to resourceId expression
            const depEntity = [...entityNames.entries()].find(([, n]) => n === dep)?.[0];
            if (depEntity) {
              return `[resourceId('${depEntity.entityType}', '${dep}')]`;
            }
            return dep;
          });
        }
      }

      template.resources.push(resource);
    }
  }

  // Inject default tags into taggable resources
  if (defaultTagEntries.length > 0) {
    const taggable = loadTaggableResources();
    for (const resource of template.resources) {
      if (!taggable.has(resource.type)) continue;
      const resolved: Record<string, unknown> = {};
      for (const t of defaultTagEntries) {
        resolved[t.key] = toArmValue(t.value, entityNames);
      }
      const existing = resource.tags ?? {};
      // Explicit tags take precedence
      resource.tags = { ...resolved, ...(existing as Record<string, unknown>) };
    }
  }

  // Auto-infer dependsOn from resourceId()/reference() expressions in properties.
  // ARM only auto-infers dependencies from reference(), not resourceId().
  const resourceNameSet = new Set(template.resources.map((r) => r.name));
  for (const resource of template.resources) {
    const refs = findArmResourceRefs(resource.properties);
    // Also scan resource-level fields (location, tags, identity, etc.)
    for (const field of RESOURCE_LEVEL_FIELDS) {
      const val = (resource as Record<string, unknown>)[field];
      if (val !== undefined) {
        for (const ref of findArmResourceRefs(val)) {
          refs.add(ref);
        }
      }
    }
    // Also scan the name field for parent references (e.g. "vnet/subnet")
    if (typeof resource.name === "string") {
      for (const ref of findArmResourceRefs(resource.name)) {
        refs.add(ref);
      }
    }

    // Infer parent dependency for child resources (e.g. "vnet/subnet" depends on "vnet")
    if (typeof resource.name === "string" && resource.name.includes("/")) {
      const parentName = resource.name.split("/")[0];
      if (resourceNameSet.has(parentName)) {
        refs.add(parentName);
      }
    }

    if (refs.size > 0) {
      const existing = new Set(resource.dependsOn ?? []);
      for (const refName of refs) {
        // Only add if the referenced resource exists in this template and isn't self
        if (refName === resource.name) continue;
        if (!resourceNameSet.has(refName)) continue;
        // Find the resource to build the resourceId expression
        const depResource = template.resources.find((r) => r.name === refName);
        if (depResource) {
          const depExpr = `[resourceId('${depResource.type}', '${refName}')]`;
          if (!existing.has(depExpr)) {
            existing.add(depExpr);
          }
        }
      }
      if (existing.size > 0) {
        resource.dependsOn = [...existing];
      }
    }
  }

  // Emit StackOutput entities as ARM outputs
  for (const [name, entity] of entities) {
    if (isStackOutput(entity)) {
      if (!template.outputs) template.outputs = {};
      const stackOutput = entity as StackOutput;
      const ref = stackOutput.sourceRef;
      const logicalName = ref.getLogicalName();
      if (logicalName) {
        template.outputs[name] = {
          type: "string",
          value: `[reference('${logicalName}').${ref.attribute}]`,
        };
      }
    }
  }

  // Add LexiconOutputs
  if (outputs && outputs.length > 0) {
    template.outputs = template.outputs ?? {};
    for (const output of outputs) {
      template.outputs[output.outputName] = {
        type: "string",
        value: `[reference('${output.sourceEntity}').${output.sourceAttribute}]`,
      };
    }
  }

  return template;
}

/**
 * Map chant parameter types to ARM parameter types.
 */
function mapParameterType(paramType: string): string {
  switch (paramType) {
    case "String": return "string";
    case "Number": return "int";
    case "CommaDelimitedList": return "array";
    default: return "string";
  }
}

/**
 * Azure ARM template serializer implementation.
 */
export const azureSerializer: Serializer = {
  name: "azure",
  rulePrefix: "AZR",

  serialize(entities: Map<string, Declarable>, outputs?: LexiconOutput[]): string | SerializerResult {
    // Check for child projects (linked templates)
    let hasChildProjects = false;
    const allFiles: Record<string, string> = {};

    for (const [, entity] of entities) {
      if (isChildProject(entity)) {
        hasChildProjects = true;
        const childProject = entity as ChildProjectInstance;
        if (childProject.buildResult) {
          const childOutput = childProject.buildResult.outputs.get("azure");
          if (childOutput) {
            const childName = childProject.logicalName;
            const filename = `${childName}.template.json`;
            if (typeof childOutput === "string") {
              allFiles[filename] = childOutput;
            } else {
              allFiles[filename] = childOutput.primary;
              if (childOutput.files) {
                for (const [f, c] of Object.entries(childOutput.files)) {
                  allFiles[f] = c;
                }
              }
            }
          }
        }
      }
    }

    const template = serializeToTemplate(entities, outputs);
    const primary = JSON.stringify(template, null, 2);

    if (!hasChildProjects) {
      return primary;
    }

    return { primary, files: allFiles };
  },
};
