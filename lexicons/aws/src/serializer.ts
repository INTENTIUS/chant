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

/**
 * Check if a declarable is a CoreParameter
 */
function isCoreParameter(entity: Declarable): entity is CoreParameter {
  return "parameterType" in entity;
}

/**
 * CloudFormation template structure
 */
interface CFTemplate {
  AWSTemplateFormatVersion: "2010-09-09";
  Description?: string;
  Parameters?: Record<string, CFParameter>;
  Resources: Record<string, CFResource>;
  Outputs?: Record<string, CFOutput>;
}

/**
 * CloudFormation parameter
 */
interface CFParameter {
  Type: string;
  Description?: string;
  Default?: unknown;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  ConstraintDescription?: string;
  MaxLength?: number;
  MaxValue?: number;
  MinLength?: number;
  MinValue?: number;
  NoEcho?: boolean;
}

/**
 * CloudFormation resource
 */
interface CFResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  UpdatePolicy?: unknown;
  CreationPolicy?: unknown;
  Metadata?: Record<string, unknown>;
}

/**
 * CloudFormation output
 */
interface CFOutput {
  Value: unknown;
  Description?: string;
  Export?: { Name: unknown };
  Condition?: string;
}

/**
 * CloudFormation-specific visitor for the generic serializer walker.
 */
function cfnVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, attr) => ({ "Fn::GetAtt": [name, attr] }),
    resourceRef: (name) => ({ Ref: name }),
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const cfProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          cfProps[key] = walk(value);
        }
      }
      return Object.keys(cfProps).length > 0 ? cfProps : undefined;
    },
  };
}

/**
 * Convert a value to CF-compatible JSON using the generic walker.
 */
function toCFValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, cfnVisitor(entityNames));
}

/**
 * Convert entity props to CF properties
 */
function toProperties(
  entity: Declarable,
  entityNames: Map<Declarable, string>
): Record<string, unknown> | undefined {
  if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
    return undefined;
  }

  const props = entity.props as Record<string, unknown>;
  const cfProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) {
      cfProps[key] = toCFValue(value, entityNames);
    }
  }

  return Object.keys(cfProps).length > 0 ? cfProps : undefined;
}


/**
 * Serialize a set of entities into a CFTemplate object (without JSON.stringify).
 */
function serializeToTemplate(
  entities: Map<string, Declarable>,
  outputs?: LexiconOutput[],
  extraParameters?: Record<string, CFParameter>,
  extraOutputs?: Record<string, CFOutput>,
): CFTemplate {
  const template: CFTemplate = {
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {},
  };

  // Add extra parameters (e.g. TemplateBasePath)
  if (extraParameters && Object.keys(extraParameters).length > 0) {
    template.Parameters = { ...extraParameters };
  }

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
    // Skip StackOutput entities — they go in the Outputs section
    if (isStackOutput(entity)) {
      continue;
    }

    // Skip DefaultTags entities — handled via tag injection below
    if (isDefaultTags(entity)) {
      continue;
    }

    if (isCoreParameter(entity)) {
      if (!template.Parameters) {
        template.Parameters = {};
      }

      const param: CFParameter = {
        Type: entity.parameterType,
      };

      if ("description" in entity && typeof entity.description === "string") {
        param.Description = entity.description;
      }

      if ("defaultValue" in entity && entity.defaultValue !== undefined) {
        param.Default = entity.defaultValue;
      }

      template.Parameters[name] = param;
    } else if (isChildProject(entity)) {
      // ChildProjectInstance → AWS::CloudFormation::Stack resource
      const childProject = entity as ChildProjectInstance;
      const childName = childProject.logicalName;
      const filename = `${childName}.template.json`;

      const properties: Record<string, unknown> = {
        TemplateURL: {
          "Fn::Sub": `\${TemplateBasePath}/${filename}`,
        },
      };

      // Build parameters: always pass TemplateBasePath down
      const parameters: Record<string, unknown> = {
        TemplateBasePath: { Ref: "TemplateBasePath" },
      };

      // Add user-specified parameters
      const opts = childProject.options as { parameters?: Record<string, unknown> };
      if (opts.parameters) {
        for (const [key, value] of Object.entries(opts.parameters)) {
          parameters[key] = value;
        }
      }

      properties.Parameters = parameters;

      template.Resources[name] = {
        Type: "AWS::CloudFormation::Stack",
        Properties: properties,
      };
    } else if (!isPropertyDeclarable(entity)) {
      const resource: CFResource = {
        Type: entity.entityType,
      };

      // Read resource-level attributes from the second constructor arg
      const attrs = ("attributes" in entity && typeof entity.attributes === "object" && entity.attributes !== null)
        ? entity.attributes as Record<string, unknown>
        : undefined;

      if (attrs) {
        // DependsOn — resolve Declarable refs to logical names
        if (attrs.DependsOn !== undefined) {
          const resolved = resolveDependsOn(attrs.DependsOn, entityNames, name);
          if (resolved.length > 0) {
            resource.DependsOn = resolved.length === 1 ? resolved[0] : resolved;
          }
        }
        // Pass-through attributes
        if (attrs.Condition) resource.Condition = attrs.Condition as string;
        if (attrs.DeletionPolicy) resource.DeletionPolicy = attrs.DeletionPolicy as string;
        if (attrs.UpdateReplacePolicy) resource.UpdateReplacePolicy = attrs.UpdateReplacePolicy as string;
        if (attrs.UpdatePolicy) resource.UpdatePolicy = attrs.UpdatePolicy;
        if (attrs.CreationPolicy) resource.CreationPolicy = attrs.CreationPolicy;
        if (attrs.Metadata) resource.Metadata = toCFValue(attrs.Metadata, entityNames) as Record<string, unknown>;
      }

      const properties = toProperties(entity, entityNames);
      if (properties) {
        if (Object.keys(properties).length > 0) {
          resource.Properties = properties;
        }
      }

      template.Resources[name] = resource;
    }
  }

  // Inject default tags into taggable resources
  if (defaultTagEntries.length > 0) {
    const taggable = loadTaggableResources();
    for (const [, resource] of Object.entries(template.Resources)) {
      if (!taggable.has(resource.Type)) continue;
      const resolved = defaultTagEntries.map(t => ({
        Key: t.Key,
        Value: toCFValue(t.Value, entityNames),
      }));
      const explicit = (resource.Properties?.Tags ?? []) as Array<{ Key: string }>;
      const explicitKeys = new Set(explicit.map(t => t.Key));
      const merged = [...resolved.filter(t => !explicitKeys.has(t.Key)), ...explicit];
      if (!resource.Properties) resource.Properties = {};
      resource.Properties.Tags = merged;
    }
  }

  // Emit StackOutput entities as CF Outputs
  for (const [name, entity] of entities) {
    if (isStackOutput(entity)) {
      if (!template.Outputs) {
        template.Outputs = {};
      }
      const stackOutput = entity as StackOutput;
      const ref = stackOutput.sourceRef;
      const logicalName = ref.getLogicalName();
      if (logicalName) {
        const output: CFOutput = {
          Value: { "Fn::GetAtt": [logicalName, ref.attribute] },
        };
        if (stackOutput.description) {
          output.Description = stackOutput.description;
        }
        template.Outputs[name] = output;
      }
    }
  }

  // Add CF Outputs for LexiconOutputs produced by this lexicon
  if (outputs && outputs.length > 0) {
    template.Outputs = template.Outputs ?? {};
    for (const output of outputs) {
      template.Outputs[output.outputName] = {
        Value: {
          "Fn::GetAtt": [output.sourceEntity, output.sourceAttribute],
        },
      };
    }
  }

  // Add extra outputs (e.g. auto-wired cross-stack refs)
  if (extraOutputs && Object.keys(extraOutputs).length > 0) {
    template.Outputs = { ...template.Outputs, ...extraOutputs };
  }

  return template;
}

/**
 * AWS CloudFormation serializer implementation
 */
export const awsSerializer: Serializer = {
  name: "aws",
  rulePrefix: "WAW",

  serialize(entities: Map<string, Declarable>, outputs?: LexiconOutput[]): string | SerializerResult {
    // Check if any entities are child projects (nested stacks)
    const childProjects = new Map<string, ChildProjectInstance>();
    let hasChildProjects = false;

    for (const [name, entity] of entities) {
      if (isChildProject(entity)) {
        childProjects.set(name, entity as ChildProjectInstance);
        hasChildProjects = true;
      }
    }

    // No nested stacks — use the simple path
    if (!hasChildProjects) {
      const template = serializeToTemplate(entities, outputs);
      return JSON.stringify(template, null, 2);
    }

    // Has child projects — produce multi-file output
    const allFiles: Record<string, string> = {};

    // Add TemplateBasePath parameter to the parent template
    const parentParams: Record<string, CFParameter> = {
      TemplateBasePath: {
        Type: "String",
        Default: ".",
        Description: "Base URL/path for nested stack templates",
      },
    };

    // Collect child template files from build results
    for (const [, childProject] of childProjects) {
      if (childProject.buildResult) {
        const childOutput = childProject.buildResult.outputs.get("aws");
        if (childOutput) {
          const childName = childProject.logicalName;
          const filename = `${childName}.template.json`;

          if (typeof childOutput === "string") {
            allFiles[filename] = childOutput;
          } else {
            // SerializerResult — the child itself has child templates
            allFiles[filename] = childOutput.primary;
            if (childOutput.files) {
              for (const [childFile, content] of Object.entries(childOutput.files)) {
                allFiles[childFile] = content;
              }
            }
          }
        }
      }
    }

    // Serialize the parent template (ChildProjectInstance entities become CF::Stack resources)
    const parentTemplate = serializeToTemplate(entities, outputs, parentParams);
    const primary = JSON.stringify(parentTemplate, null, 2);

    return {
      primary,
      files: allFiles,
    };
  },
};
