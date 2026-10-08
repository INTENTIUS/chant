import type {
  TemplateParser,
  TemplateIR,
  ResourceIR,
  ParameterIR,
  ConditionIR,
  OutputIR,
} from "@intentius/chant/import/parser";
import { BaseValueParser } from "@intentius/chant/import/base-parser";
import yaml from "js-yaml";

/**
 * Custom YAML schema for CloudFormation shorthand tags (!Ref, !Sub, !GetAtt, etc.)
 */
const cfnYamlTypes = [
  new yaml.Type("!Ref", {
    kind: "scalar",
    construct: (data: string) => ({ Ref: data }),
  }),
  new yaml.Type("!Sub", {
    kind: "scalar",
    construct: (data: string) => ({ "Fn::Sub": data }),
  }),
  new yaml.Type("!Sub", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Sub": data }),
  }),
  new yaml.Type("!GetAtt", {
    kind: "scalar",
    // `!GetAtt Db.Endpoint.Address` names the attribute `Endpoint.Address`:
    // the logical id ends at the first dot.
    construct: (data: string) => {
      const dot = data.indexOf(".");
      return { "Fn::GetAtt": dot < 0 ? [data] : [data.slice(0, dot), data.slice(dot + 1)] };
    },
  }),
  new yaml.Type("!GetAtt", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::GetAtt": data }),
  }),
  new yaml.Type("!Join", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Join": data }),
  }),
  new yaml.Type("!Select", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Select": data }),
  }),
  new yaml.Type("!Split", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Split": data }),
  }),
  new yaml.Type("!If", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::If": data }),
  }),
  new yaml.Type("!Equals", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Equals": data }),
  }),
  new yaml.Type("!Not", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Not": data }),
  }),
  new yaml.Type("!And", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::And": data }),
  }),
  new yaml.Type("!Or", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Or": data }),
  }),
  new yaml.Type("!FindInMap", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::FindInMap": data }),
  }),
  new yaml.Type("!Base64", {
    kind: "scalar",
    construct: (data: string) => ({ "Fn::Base64": data }),
  }),
  new yaml.Type("!Base64", {
    kind: "mapping",
    construct: (data: unknown) => ({ "Fn::Base64": data }),
  }),
  new yaml.Type("!Cidr", {
    kind: "sequence",
    construct: (data: unknown[]) => ({ "Fn::Cidr": data }),
  }),
  new yaml.Type("!ImportValue", {
    kind: "scalar",
    construct: (data: string) => ({ "Fn::ImportValue": data }),
  }),
  new yaml.Type("!ImportValue", {
    kind: "mapping",
    construct: (data: unknown) => ({ "Fn::ImportValue": data }),
  }),
  new yaml.Type("!GetAZs", {
    kind: "scalar",
    construct: (data: string) => ({ "Fn::GetAZs": data }),
  }),
  new yaml.Type("!GetAZs", {
    kind: "mapping",
    construct: (data: unknown) => ({ "Fn::GetAZs": data }),
  }),
  new yaml.Type("!Transform", {
    kind: "mapping",
    construct: (data: unknown) => ({ "Fn::Transform": data }),
  }),
  new yaml.Type("!Condition", {
    kind: "scalar",
    construct: (data: string) => ({ Condition: data }),
  }),
];

const CF_SCHEMA = yaml.DEFAULT_SCHEMA.extend(cfnYamlTypes);

/**
 * CloudFormation template structure
 */
interface CFTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Metadata?: Record<string, unknown>;
  Parameters?: Record<string, CFParameter>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, CFResource>;
  Outputs?: Record<string, CFOutput>;
}

/**
 * CloudFormation output
 */
interface CFOutput {
  Value: unknown;
  Description?: string;
  Export?: { Name?: unknown };
  Condition?: string;
}

/**
 * CloudFormation parameter
 */
interface CFParameter {
  Type: string;
  Description?: string;
  Default?: unknown;
  [constraint: string]: unknown;
}

/** Parameter keys import carries besides Type, Description and Default. */
const PARAMETER_CONSTRAINT_KEYS = [
  "AllowedValues",
  "AllowedPattern",
  "ConstraintDescription",
  "MinLength",
  "MaxLength",
  "MinValue",
  "MaxValue",
  "NoEcho",
] as const;

/** Resource attributes import carries besides Type, Properties, Metadata and Condition. */
const RESOURCE_ATTRIBUTE_KEYS = ["DependsOn", "DeletionPolicy", "UpdateReplacePolicy", "UpdatePolicy", "CreationPolicy"] as const;

/**
 * CloudFormation resource
 */
interface CFResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
  DependsOn?: string | string[];
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  UpdatePolicy?: unknown;
  CreationPolicy?: unknown;
}

/**
 * Parser for CloudFormation JSON templates.
 * Extends BaseValueParser for generic recursive value walking;
 * overrides dispatchIntrinsic with the CFN-specific dispatch table.
 */
export class CFParser extends BaseValueParser implements TemplateParser {
  /**
   * Parse CF JSON content into intermediate representation
   */
  parse(content: string): TemplateIR {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = yaml.load(content, { schema: CF_SCHEMA });
    }
    const template = parsed as CFTemplate;

    const parameters = this.parseParameters(template.Parameters ?? {});
    const conditions = this.parseConditions(template.Conditions ?? {});
    const resources = this.parseResources(template.Resources ?? {});
    const outputs = this.parseOutputs(template.Outputs ?? {});
    const warnings = this.collectDroppedSectionWarnings(template as unknown as Record<string, unknown>);

    return {
      parameters,
      conditions: conditions.length > 0 ? conditions : undefined,
      resources,
      outputs: outputs.length > 0 ? outputs : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        version: template.AWSTemplateFormatVersion ?? "2010-09-09",
        description: template.Description,
        ...(template.Metadata !== undefined ? { templateMetadata: this.parseValue(template.Metadata) } : {}),
      },
    };
  }

  /**
   * Template sections import carries. Anything else is named in a warning
   * rather than dropped silently (#2069).
   */
  private static readonly CARRIED_SECTIONS = new Set([
    "AWSTemplateFormatVersion",
    "Description",
    "Metadata",
    "Parameters",
    "Conditions",
    "Resources",
    "Outputs",
  ]);

  private collectDroppedSectionWarnings(template: Record<string, unknown>): string[] {
    const warnings: string[] = [];
    for (const key of Object.keys(template)) {
      if (!CFParser.CARRIED_SECTIONS.has(key)) {
        warnings.push(`Template section "${key}" is not carried by import — it is dropped from the generated source`);
      }
    }
    return warnings;
  }

  /**
   * Parse the Conditions section (#2069). Inside a condition expression the
   * single-key `{ "Condition": "<name>" }` form references another declared
   * condition; `inConditionExpression` scopes that dispatch to this section
   * so a resource property that happens to hold a single-key `Condition`
   * object is left alone.
   */
  private inConditionExpression = false;

  private parseConditions(conditions: Record<string, unknown>): ConditionIR[] {
    return Object.entries(conditions).map(([name, expression]) => {
      this.inConditionExpression = true;
      try {
        return { name, expression: this.parseValue(expression) };
      } finally {
        this.inConditionExpression = false;
      }
    });
  }

  /**
   * Parse the Outputs section (#2069).
   */
  private parseOutputs(outputs: Record<string, CFOutput>): OutputIR[] {
    return Object.entries(outputs)
      .filter(([_, output]) => typeof output === "object" && output !== null)
      .map(([name, output]) => ({
        name,
        value: this.parseValue(output.Value),
        description: output.Description,
        exportName: output.Export?.Name !== undefined ? this.parseValue(output.Export.Name) : undefined,
        condition: typeof output.Condition === "string" ? output.Condition : undefined,
      }));
  }

  /**
   * Parse parameters section
   */
  private parseParameters(params: Record<string, CFParameter>): ParameterIR[] {
    return Object.entries(params).map(([name, param]) => {
      const constraints = Object.fromEntries(
        PARAMETER_CONSTRAINT_KEYS.filter((k) => param[k] !== undefined).map((k) => [k, param[k]]),
      );
      return {
        name,
        type: param.Type,
        description: param.Description,
        defaultValue: param.Default,
        required: param.Default === undefined,
        ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
      };
    });
  }

  /**
   * Parse resources section
   */
  private parseResources(resources: Record<string, CFResource>): ResourceIR[] {
    return Object.entries(resources)
      .filter(([_, resource]) => typeof resource?.Type === "string")
      .map(([logicalId, resource]) => {
        const attributes = Object.fromEntries(
          RESOURCE_ATTRIBUTE_KEYS.filter((k) => resource[k] !== undefined).map((k) => [k, this.parseValue(resource[k])]),
        );
        return {
          logicalId,
          type: resource.Type,
          properties: this.parseProperties(resource.Properties ?? {}),
          metadata: resource.Metadata !== undefined ? (this.parseValue(resource.Metadata) as Record<string, unknown>) : undefined,
          condition: typeof resource.Condition === "string" ? resource.Condition : undefined,
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        };
      });
  }

  /**
   * Parse resource properties, handling intrinsic functions
   */
  private parseProperties(props: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(props)) {
      result[key] = this.parseValue(value);
    }

    return result;
  }

  /**
   * CFN-specific intrinsic dispatch table.
   */
  protected dispatchIntrinsic(key: string, value: unknown, _obj: Record<string, unknown>): unknown | null {
    // `{ "Condition": "<name>" }` — only valid inside the Conditions section
    // (#2069); see parseConditions for the scoping.
    if (key === "Condition" && this.inConditionExpression && typeof value === "string") {
      return { __intrinsic: "ConditionRef", name: value };
    }

    if (key === "Ref") {
      return { __intrinsic: "Ref", name: value };
    }

    if (key === "Fn::GetAtt") {
      if (Array.isArray(value) && value.length === 2) {
        return { __intrinsic: "GetAtt", logicalId: value[0], attribute: value[1] };
      }
      if (typeof value === "string" && value.indexOf(".") > 0) {
        const dot = value.indexOf(".");
        return { __intrinsic: "GetAtt", logicalId: value.slice(0, dot), attribute: value.slice(dot + 1) };
      }
    }

    if (key === "Fn::Sub") {
      if (typeof value === "string") {
        return { __intrinsic: "Sub", template: value };
      }
      if (Array.isArray(value) && value.length >= 1) {
        return { __intrinsic: "Sub", template: value[0], variables: value[1] };
      }
    }

    if (key === "Fn::If") {
      const ifValue = value as unknown[];
      return {
        __intrinsic: "If",
        condition: ifValue[0],
        valueIfTrue: this.parseValue(ifValue[1]),
        valueIfFalse: this.parseValue(ifValue[2]),
      };
    }

    if (key === "Fn::Join") {
      const joinValue = value as [string, unknown];
      const delimiter = joinValue[0];
      const source = joinValue[1];
      return {
        __intrinsic: "Join",
        delimiter,
        values: Array.isArray(source)
          ? source.map((v) => this.parseValue(v))
          : [this.parseValue(source)],
      };
    }

    if (key === "Fn::Select") {
      // The index is kept as written (0 or "0"). A list source is `values`;
      // anything else (a Ref to a list parameter, Fn::GetAZs, Fn::Split) is
      // `source`, the list itself. Wrapping it in a list would select the
      // list rather than an item of it.
      const selectValue = value as [string | number, unknown];
      const index = selectValue[0];
      const source = selectValue[1];
      if (Array.isArray(source)) {
        return {
          __intrinsic: "Select",
          index,
          values: source.map((v) => this.parseValue(v)),
        };
      }
      return {
        __intrinsic: "Select",
        index,
        source: this.parseValue(source),
      };
    }

    if (key === "Fn::Split") {
      const splitValue = value as [string, unknown];
      return {
        __intrinsic: "Split",
        delimiter: splitValue[0],
        source: this.parseValue(splitValue[1]),
      };
    }

    if (key === "Fn::Base64") {
      return { __intrinsic: "Base64", value: this.parseValue(value) };
    }

    if (key === "Fn::FindInMap") {
      const mapValue = value as unknown[];
      return {
        __intrinsic: "FindInMap",
        mapName: mapValue[0],
        firstKey: this.parseValue(mapValue[1]),
        secondKey: this.parseValue(mapValue[2]),
      };
    }

    if (key === "Fn::GetAZs") {
      return { __intrinsic: "GetAZs", region: this.parseValue(value) };
    }

    if (key === "Fn::ImportValue") {
      return { __intrinsic: "ImportValue", value: this.parseValue(value) };
    }

    if (key === "Fn::Cidr") {
      const cidrValue = value as unknown[];
      return {
        __intrinsic: "Cidr",
        ipBlock: this.parseValue(cidrValue[0]),
        count: this.parseValue(cidrValue[1]),
        cidrBits: this.parseValue(cidrValue[2]),
      };
    }

    if (key === "Fn::Transform") {
      return { __intrinsic: "Transform", value };
    }

    if (key === "Fn::Equals") {
      const eqValue = value as unknown[];
      return {
        __intrinsic: "Equals",
        left: this.parseValue(eqValue[0]),
        right: this.parseValue(eqValue[1]),
      };
    }

    if (key === "Fn::Not") {
      const notValue = value as unknown[];
      return { __intrinsic: "Not", condition: this.parseValue(notValue[0]) };
    }

    if (key === "Fn::And") {
      const andValue = value as unknown[];
      return { __intrinsic: "And", conditions: andValue.map((v) => this.parseValue(v)) };
    }

    if (key === "Fn::Or") {
      const orValue = value as unknown[];
      return { __intrinsic: "Or", conditions: orValue.map((v) => this.parseValue(v)) };
    }

    return null;
  }
}
