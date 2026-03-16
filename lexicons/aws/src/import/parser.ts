import type {
  TemplateParser,
  TemplateIR,
  ResourceIR,
  ParameterIR,
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
    construct: (data: string) => ({ "Fn::GetAtt": data.split(".") }),
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
  Parameters?: Record<string, CFParameter>;
  Resources?: Record<string, CFResource>;
  Outputs?: Record<string, unknown>;
}

/**
 * CloudFormation parameter
 */
interface CFParameter {
  Type: string;
  Description?: string;
  Default?: unknown;
}

/**
 * CloudFormation resource
 */
interface CFResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
  DependsOn?: string | string[];
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
    const resources = this.parseResources(template.Resources ?? {});

    return {
      parameters,
      resources,
      metadata: {
        version: template.AWSTemplateFormatVersion ?? "2010-09-09",
        description: template.Description,
      },
    };
  }

  /**
   * Parse parameters section
   */
  private parseParameters(params: Record<string, CFParameter>): ParameterIR[] {
    return Object.entries(params).map(([name, param]) => ({
      name,
      type: param.Type,
      description: param.Description,
      defaultValue: param.Default,
      required: param.Default === undefined,
    }));
  }

  /**
   * Parse resources section
   */
  private parseResources(resources: Record<string, CFResource>): ResourceIR[] {
    return Object.entries(resources)
      .filter(([_, resource]) => typeof resource?.Type === "string")
      .map(([logicalId, resource]) => ({
        logicalId,
        type: resource.Type,
        properties: this.parseProperties(resource.Properties ?? {}),
        metadata: resource.Metadata,
      }));
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
    if (key === "Ref") {
      return { __intrinsic: "Ref", name: value };
    }

    if (key === "Fn::GetAtt") {
      if (Array.isArray(value) && value.length === 2) {
        return { __intrinsic: "GetAtt", logicalId: value[0], attribute: value[1] };
      }
      if (typeof value === "string") {
        const [logicalId, attribute] = value.split(".", 2);
        return { __intrinsic: "GetAtt", logicalId, attribute };
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
      const selectValue = value as [string | number, unknown];
      const index = Number(selectValue[0]);
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
        values: [this.parseValue(source)],
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
