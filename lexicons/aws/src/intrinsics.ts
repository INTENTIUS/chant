import { INTRINSIC_MARKER, resolveIntrinsicValue, type Intrinsic } from "@intentius/chant/intrinsic";
import { buildInterpolatedString, defaultInterpolationSerializer } from "@intentius/chant/intrinsic-interpolation";

/**
 * Fn::Sub intrinsic function implementation
 * Supports template string interpolation with AttrRefs, Declarables, and pseudo-parameters
 */
export class SubIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private templateParts: string[];
  private values: unknown[];

  constructor(templateParts: string[], values: unknown[]) {
    this.templateParts = templateParts;
    this.values = values;
  }

  toJSON(): { "Fn::Sub": string } {
    const serialize = defaultInterpolationSerializer(
      (name, attr) => `\${${name}.${attr}}`,
      (ref) => `\${${ref}}`,
    );
    return { "Fn::Sub": buildInterpolatedString(this.templateParts, this.values, serialize) };
  }
}

/**
 * Tagged template function for creating Fn::Sub intrinsics
 * Usage: Sub`${AWS.StackName}-bucket` or Sub`${bucket.arn}`
 */
export function Sub(
  templateParts: TemplateStringsArray,
  ...values: unknown[]
): SubIntrinsic {
  return new SubIntrinsic([...templateParts], values);
}

/**
 * Ref intrinsic function
 * References a parameter or resource by logical name
 */
export class RefIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  toJSON(): { Ref: string } {
    return { Ref: this.name };
  }
}

/**
 * Create a Ref intrinsic
 */
export function Ref(name: string): RefIntrinsic {
  return new RefIntrinsic(name);
}

/**
 * Fn::GetAtt intrinsic function
 * Gets an attribute from a resource
 */
export class GetAttIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private logicalName: string;
  private attribute: string;

  constructor(logicalName: string, attribute: string) {
    this.logicalName = logicalName;
    this.attribute = attribute;
  }

  toJSON(): { "Fn::GetAtt": [string, string] } {
    return { "Fn::GetAtt": [this.logicalName, this.attribute] };
  }
}

/**
 * Create a GetAtt intrinsic
 */
export function GetAtt(logicalName: string, attribute: string): GetAttIntrinsic {
  return new GetAttIntrinsic(logicalName, attribute);
}

/**
 * Fn::If intrinsic function
 * Conditional value based on a condition
 */
export class IfIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private conditionName: string;
  private valueIfTrue: unknown;
  private valueIfFalse: unknown;

  constructor(conditionName: string, valueIfTrue: unknown, valueIfFalse: unknown) {
    this.conditionName = conditionName;
    this.valueIfTrue = valueIfTrue;
    this.valueIfFalse = valueIfFalse;
  }

  toJSON(): { "Fn::If": [string, unknown, unknown] } {
    return { "Fn::If": [this.conditionName, resolveIntrinsicValue(this.valueIfTrue), resolveIntrinsicValue(this.valueIfFalse)] };
  }
}


/**
 * Create an If intrinsic
 */
export function If(conditionName: string, valueIfTrue: unknown, valueIfFalse: unknown): IfIntrinsic {
  return new IfIntrinsic(conditionName, valueIfTrue, valueIfFalse);
}

/**
 * Fn::Join intrinsic function
 * Joins values with a delimiter
 */
export class JoinIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private delimiter: string;
  private values: unknown[];

  constructor(delimiter: string, values: unknown[]) {
    this.delimiter = delimiter;
    this.values = values;
  }

  toJSON(): { "Fn::Join": [string, unknown[]] } {
    return { "Fn::Join": [this.delimiter, this.values.map(resolveIntrinsicValue)] };
  }
}

/**
 * Create a Join intrinsic
 */
export function Join(delimiter: string, values: unknown[]): JoinIntrinsic {
  return new JoinIntrinsic(delimiter, values);
}

/**
 * Fn::Select intrinsic function
 * Selects a value from a list by index
 */
export class SelectIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private index: number;
  private values: unknown[];

  constructor(index: number, values: unknown[]) {
    this.index = index;
    this.values = values;
  }

  toJSON(): { "Fn::Select": [string, unknown[]] } {
    return { "Fn::Select": [String(this.index), this.values.map(resolveIntrinsicValue)] };
  }
}

/**
 * Create a Select intrinsic
 */
export function Select(index: number, values: unknown[]): SelectIntrinsic {
  return new SelectIntrinsic(index, values);
}

/**
 * Fn::Split intrinsic function
 * Splits a string by delimiter
 */
export class SplitIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private delimiter: string;
  private source: string | Intrinsic;

  constructor(delimiter: string, source: string | Intrinsic) {
    this.delimiter = delimiter;
    this.source = source;
  }

  toJSON(): { "Fn::Split": [string, unknown] } {
    const sourceValue = typeof this.source === "string"
      ? this.source
      : (this.source as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::Split": [this.delimiter, sourceValue] };
  }
}

/**
 * Create a Split intrinsic
 */
export function Split(delimiter: string, source: string | Intrinsic): SplitIntrinsic {
  return new SplitIntrinsic(delimiter, source);
}

/**
 * Fn::Base64 intrinsic function
 * Encodes a string to Base64
 */
export class Base64Intrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private value: string | Intrinsic;

  constructor(value: string | Intrinsic) {
    this.value = value;
  }

  toJSON(): { "Fn::Base64": unknown } {
    const innerValue = typeof this.value === "string"
      ? this.value
      : (this.value as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::Base64": innerValue };
  }
}

/**
 * Create a Base64 intrinsic
 */
export function Base64(value: string | Intrinsic): Base64Intrinsic {
  return new Base64Intrinsic(value);
}

/**
 * Fn::GetAZs intrinsic function
 * Returns a list of Availability Zones for a region
 */
export class GetAZsIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private region: string | Intrinsic;

  constructor(region: string | Intrinsic = "") {
    this.region = region;
  }

  toJSON(): { "Fn::GetAZs": unknown } {
    const regionValue = typeof this.region === "string"
      ? this.region
      : (this.region as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::GetAZs": regionValue };
  }
}

/**
 * Create a GetAZs intrinsic
 */
export function GetAZs(region?: string | Intrinsic): GetAZsIntrinsic {
  return new GetAZsIntrinsic(region);
}
