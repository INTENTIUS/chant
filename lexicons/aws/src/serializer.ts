import type { Declarable, CoreParameter } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import { ownershipEntries, type OwnershipMarker } from "@intentius/chant/ownership";
import {
  isEffectReceipt,
  receiptExpectation,
  referenceInputPaths,
  type EffectReceiptDeclaration,
} from "@intentius/chant/effect-receipt";
import { AWS_TAG_OWNERSHIP_KEYS, OWNERSHIP_METADATA_KEY } from "./ownership";
import {
  AWS_EFFECT_RECEIPT_ENTITY_TYPE,
  EFFECT_RECEIPTS_METADATA_KEY,
  RECEIPT_UNRESOLVED_VALUE_NOTE,
  receiptParameterName,
} from "./effect-receipt-row";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { isChildProject, type ChildProjectInstance } from "@intentius/chant/child-project";
import { isStackOutput, type StackOutput } from "@intentius/chant/stack-output";
import { isAttrRefLike } from "@intentius/chant/utils";
import { resolveDependsOn } from "@intentius/chant/resource-attributes";
import { isDefaultTags, type TagEntry } from "./default-tags";
import { isTemplateTransform } from "./template-transform";
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
  Metadata?: Record<string, unknown>;
  Transform?: string | string[];
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
      if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) {
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
 * Set logical names on any AttrRefs nested inside a value (e.g. inside a `Join`
 * that a `stackOutput` exports). resolveAttrRefs only reaches entity attributes,
 * not refs buried in an output's intrinsic — without this the walker would throw
 * "logical name not set" for them (#517).
 */
function resolveNestedAttrRefs(
  value: unknown,
  entityNames: Map<Declarable, string>,
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (isAttrRefLike(value)) {
    if (!value.getLogicalName()) {
      const parent = value.parent.deref();
      const parentName = parent ? entityNames.get(parent as Declarable) : undefined;
      if (parentName) value._setLogicalName(parentName);
    }
    return;
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) resolveNestedAttrRefs(child, entityNames, seen);
}

/**
 * Convert entity props to CF properties
 */
function toProperties(
  entity: Declarable,
  entityNames: Map<Declarable, string>
): Record<string, unknown> | undefined {
  if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) {
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


/** One rendered receipt row — a CFN-resource-shaped object that lives in the
 * template's `Metadata`, never in `Resources` (#1832: the applier writes from
 * `Resources`, and the `effect()` step is a receipt's sole writer). */
interface ReceiptRow {
  Type: typeof AWS_EFFECT_RECEIPT_ENTITY_TYPE;
  Properties: {
    Name: string;
    Type: "String";
    Value: string;
    Tags: Array<{ Key: string; Value: string }>;
  };
}

/** The rendered `Value`: the synthesis-time expectation when the receipt is
 * fully static, a placeholder note when reference inputs resolve later —
 * never a digest hashed over placeholders (epic #1703, decision 5). */
function receiptRowValue(receipt: EffectReceiptDeclaration): string {
  if (receipt.flavor === "hash" && referenceInputPaths(receipt).length > 0) {
    return RECEIPT_UNRESOLVED_VALUE_NOTE;
  }
  return receiptExpectation(receipt);
}

/**
 * Render the effect receipts (#1835) the build withheld from the apply-bound
 * entity set (`SerializeContext.receipts`, #1832) as `AWS::SSM::Parameter`
 * rows: plain `String`, named `/chant-receipts/<stack>/<env>/<effect>` from
 * the resolved ownership marker (epic decision 4 — the same fields that stamp
 * tags), carrying the ownership tags. Visibility only: the rows go under the
 * template's `Metadata`, and the receipt store (./receipt-store.ts) is what
 * actually writes the parameter — through the `effect()` step, on success,
 * last.
 *
 * The env segment is explicit: a receipt with no resolved `ownership.env` is
 * an error here, never a guessed path.
 */
function renderReceiptRows(
  receipts: ReadonlyMap<string, Declarable>,
  ownership: OwnershipMarker | undefined,
): Record<string, ReceiptRow> {
  const rows: Record<string, ReceiptRow> = {};
  const names = [...receipts.keys()].join(", ");
  if (!ownership) {
    throw new Error(
      `aws receipts (${names}): no ownership marker resolved — the receipt path is ` +
        `/chant-receipts/<stack>/<env>/<effect>, derived from the same ownership fields that ` +
        `stamp markers (chant #1703, decision 4). Set ownership: { stack, env } in chant.config.ts.`,
    );
  }
  if (!ownership.env) {
    throw new Error(
      `aws receipts (${names}): ownership resolved no env — the receipt path's <env> segment is ` +
        `explicit (chant #1703, decision 4). Set ownership.env in chant.config.ts (a literal, or ` +
        `{ param: "env" } with --param env=<name>).`,
    );
  }
  const tags = Object.entries(ownershipEntries(AWS_TAG_OWNERSHIP_KEYS, ownership)).map(
    ([Key, Value]) => ({ Key, Value }),
  );
  for (const [name, entity] of receipts) {
    if (!isEffectReceipt(entity)) continue;
    rows[name] = {
      Type: AWS_EFFECT_RECEIPT_ENTITY_TYPE,
      Properties: {
        Name: receiptParameterName(ownership.stack, ownership.env, entity.effect),
        Type: "String",
        Value: receiptRowValue(entity),
        Tags: tags,
      },
    };
  }
  return rows;
}

/**
 * Serialize a set of entities into a CFTemplate object (without JSON.stringify).
 */
function serializeToTemplate(
  entities: Map<string, Declarable>,
  outputs?: LexiconOutput[],
  extraParameters?: Record<string, CFParameter>,
  extraOutputs?: Record<string, CFOutput>,
  ownership?: OwnershipMarker,
  receiptRows?: Record<string, ReceiptRow>,
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

  // Collect default tags. The ownership marker is stamped as tags, seeded
  // first so user default tags (and explicit per-resource tags) take precedence
  // on key collisions.
  const defaultTagEntries: TagEntry[] = [];
  if (ownership) {
    for (const [Key, Value] of Object.entries(ownershipEntries(AWS_TAG_OWNERSHIP_KEYS, ownership))) {
      defaultTagEntries.push({ Key, Value });
    }
    // Also carry the marker at the template level (#1222): stack tags are a
    // CreateStack/UpdateStack API parameter, not a template section, so the
    // apply paths read this Metadata block and stamp it as the stack's own
    // tags — what stack-level teardown verifies ownership on.
    template.Metadata = {
      [OWNERSHIP_METADATA_KEY]: ownershipEntries(AWS_TAG_OWNERSHIP_KEYS, ownership),
    };
  }
  // Effect receipt rows (#1835) — visibility only, deliberately outside
  // `Resources`: the applier's desired and prune sets both read `Resources`,
  // and the `effect()` step is a receipt's sole writer (#1832, epic #1703
  // decision 3). The observation leg (plugin.ts) reads the paths back from
  // this block, so the identity is derived exactly once, here.
  if (receiptRows && Object.keys(receiptRows).length > 0) {
    template.Metadata = { ...(template.Metadata ?? {}), [EFFECT_RECEIPTS_METADATA_KEY]: receiptRows };
  }
  for (const [, entity] of entities) {
    if (isDefaultTags(entity)) {
      defaultTagEntries.push(...entity.tags);
    }
  }

  // Collect top-level Transform macros (e.g. AWS::SecretsManager-2020-07-23),
  // de-duplicated in declaration order. One → a string, several → a list,
  // matching CloudFormation's own `Transform` shape.
  const transforms: string[] = [];
  for (const [, entity] of entities) {
    if (isTemplateTransform(entity) && !transforms.includes(entity.transform)) {
      transforms.push(entity.transform);
    }
  }
  if (transforms.length === 1) {
    template.Transform = transforms[0];
  } else if (transforms.length > 1) {
    template.Transform = transforms;
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

    // Skip TemplateTransform entities — lifted to the top-level Transform above
    if (isTemplateTransform(entity)) {
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
      const attrs = (isResourceDeclarable(entity) && typeof entity.attributes === "object" && entity.attributes !== null)
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
      // Typed `unknown` so `isAttrRefLike` narrows cleanly regardless of how the
      // AttrRef type resolves across the workspace/published boundary.
      const ref: unknown = stackOutput.sourceRef;
      let value: unknown;
      if (typeof ref === "string") {
        // Literal output (constants a stack publishes, e.g. a port number).
        value = ref;
      } else if (isAttrRefLike(ref)) {
        const logicalName = ref.getLogicalName();
        if (!logicalName) continue;
        // Use Ref for primary identifier ("Id") since not all resources
        // support Fn::GetAtt for their primary identifier (e.g. ACM Certificate).
        // Ref always returns the primary identifier for any CF resource.
        value = ref.attribute === "Id" ? { Ref: logicalName } : { "Fn::GetAtt": [logicalName, ref.attribute] };
      } else {
        // An intrinsic wrapping refs (e.g. Join(",", zone.NameServers), #517):
        // resolve the nested AttrRefs' logical names from the entity map, then
        // serialize through the CF walker → {Fn::Join:[",",{Fn::GetAtt:[…]}]}.
        resolveNestedAttrRefs(ref, entityNames);
        value = toCFValue(ref, entityNames);
      }
      const output: CFOutput = { Value: value };
      if (stackOutput.description) {
        output.Description = stackOutput.description;
      }
      // Read defensively: a project may pair this lexicon with an older
      // published core whose StackOutput type predates exportName.
      const exportName = (stackOutput as { exportName?: string }).exportName;
      if (exportName) {
        output.Export = { Name: exportName };
      }
      template.Outputs[name] = output;
    }
  }

  // Add CF Outputs for LexiconOutputs produced by this lexicon. Run the value
  // through the CF walker so an AttrRef nested in an intrinsic (e.g.
  // Join(",", [subnet1.SubnetId, …])) becomes Fn::GetAtt instead of leaking the
  // generic `{__attrRef}` envelope — the same conversion resource Properties get
  // (#935). A bare Fn::GetAtt value walks through unchanged.
  if (outputs && outputs.length > 0) {
    template.Outputs = template.Outputs ?? {};
    for (const output of outputs) {
      template.Outputs[output.outputName] = {
        Value: toCFValue(output.getOutputValue(), entityNames),
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

  serialize(entities: Map<string, Declarable>, outputs?: LexiconOutput[], context?: SerializeContext): string | SerializerResult {
    const ownership = context?.ownership;

    // Effect receipts (#1835): withheld from `entities` by the build (#1832),
    // rendered here as Metadata rows — never as `Resources` an applier would
    // write. Env-less ownership is an error, not a guessed path segment.
    const receiptRows =
      context?.receipts && context.receipts.size > 0
        ? renderReceiptRows(context.receipts, ownership)
        : undefined;

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
      const template = serializeToTemplate(entities, outputs, undefined, undefined, ownership, receiptRows);
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
    const parentTemplate = serializeToTemplate(entities, outputs, parentParams, undefined, ownership, receiptRows);
    const primary = JSON.stringify(parentTemplate, null, 2);

    return {
      primary,
      files: allFiles,
    };
  },
};
