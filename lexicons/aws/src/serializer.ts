import type { Declarable, CoreParameter } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { toPascalCase } from "@intentius/chant/codegen/case";
import { isChildProject, type ChildProjectInstance } from "@intentius/chant/child-project";
import { isStackOutput, type StackOutput } from "@intentius/chant/stack-output";

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
    attrRef: (name, attr) => ({ "Fn::GetAttr": [name, attr] }),
    resourceRef: (name) => ({ Ref: name }),
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const cfProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          const cfKey = toPascalCase(key);
          cfProps[cfKey] = walk(value);
        }
      }
      return Object.keys(cfProps).length > 0 ? cfProps : undefined;
    },
    transformKey: toPascalCase,
  };
}

/**
 * Convert a value to CF-compatible JSON using the generic walker.
 */
function toCFValue(value: unknown, entityNames: Map<Declarable, string>, convertKeys = false): unknown {
  const visitor = cfnVisitor(entityNames);
  if (!convertKeys) {
    // When not converting keys, use a visitor without transformKey
    return walkValue(value, entityNames, { ...visitor, transformKey: undefined });
  }
  return walkValue(value, entityNames, visitor);
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
      const cfKey = toPascalCase(key);
      cfProps[cfKey] = toCFValue(value, entityNames, true);
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

  // Process entities
  for (const [name, entity] of entities) {
    // Skip StackOutput entities — they go in the Outputs section
    if (isStackOutput(entity)) {
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

      const properties = toProperties(entity, entityNames);
      if (properties) {
        resource.Properties = properties;
      }

      template.Resources[name] = resource;
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
          Value: { "Fn::GetAttr": [logicalName, ref.attribute] },
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
          "Fn::GetAttr": [output.sourceEntity, output.sourceAttribute],
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
